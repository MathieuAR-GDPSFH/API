const mysql = require('mysql');
const util = require('util');
const config = require("./config.json");
const bp = require('body-parser')
const express = require('express');
const axios = require('axios');
const dedent = require('dedent')
const fs = require("fs")
const crypto = require('crypto')
const exec = util.promisify(require("child_process").exec);
const { createGDPS, createAndroidDownload, createPcAndroidDownload, createPcDownload } = require("./utils")

var app = express()
app.use(bp.json())
app.use(bp.urlencoded({ extended: true }))
app.set('trust proxy', true)

var sql_conn = mysql.createPool({
    connectionLimit : 10,
    host: config.mysql.host,
    user: config.mysql.username,
    password: config.mysql.password,
    database: config.mysql.database
});
const query = util.promisify(sql_conn.query).bind(sql_conn);

var gdps_sql_conn = mysql.createPool({
    connectionLimit : 50,
    host: config.mysql.host,
    user: config.mysql.username,
    password: config.mysql.password
});
const gdps_query = util.promisify(gdps_sql_conn.query).bind(gdps_sql_conn);

app.post("/discord/oauth/code", async (req, res) => {
    const code = req.query["code"]
    
    let req_config = {
        url: "https://discord.com/api/oauth2/token",
        method: "post",
        data: {
            "client_id": config.clientId,
            "client_secret": config.clientSecret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirect_uri
        },
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }

    let oauth_data
    try {
        const api_req = await axios(req_config)
        oauth_data = api_req.data
    } catch (err) {
        res.send("err")
        return
    }

    req_config = {
        url: "https://discordapp.com/api/users/@me",
        method: "get",
        headers: {
            "Authorization": `Bearer ${oauth_data["access_token"]}`
        }
    }

    let user_data
    try {
        const api_req = await axios(req_config)
        user_data = api_req.data
    } catch (err) {
        res.send("err")
        return
    }

    const avatar = `https://cdn.discordapp.com/avatars/${user_data["id"]}/${user_data["avatar"]}`
    const access_token = crypto.randomBytes(64).toString('hex')

    const req_response = {
        user_id: user_data["id"],
        username: user_data["username"],
        avatar: avatar,
        access_token: access_token,
        staff_permissions: []
    }

    var sql_data = await query("select role from discord_oauth where user_id = ?", [user_data["id"]])
    if (sql_data.length === 0) {
        const current_time = Math.floor(Date.now() / 1000)
        await query("insert into discord_oauth (user_id,name,avatar,token,token_expire,refresh_token,created_on,access_token) values (?,?,?,?,?,?,?,?)", [user_data["id"], user_data["username"], avatar, oauth_data["access_token"], current_time + oauth_data["expires_in"], oauth_data["refresh_token"], current_time, access_token])
    } else if (sql_data.length === 1) {
        await query("update discord_oauth set name = ?, avatar = ?, access_token = ? where user_id = ?", [user_data["username"], avatar, access_token, user_data["id"]])

        sql_data = sql_data[0]
        if (sql_data["role"] !== 0) {
            let role_perms = await query("select see_allgdps,see_allusers from roles where id = ?", [sql_data["role"]])
            role_perms = role_perms[0]
            for (const role in role_perms) {
                if (role_perms[role] === 1) {
                    req_response["staff_permissions"].push(role)
                }
            }
        }
    }

    res.send(req_response)
    console.log(`User ${user_data["username"]} just logged in.`)
})

app.get("/page/dashboard", async (req, res) => {
    let total_gdps = await query("select null from gdps where status = 1")
    total_gdps = total_gdps.length
    let total_users = await query("select null from discord_oauth")
    total_users = total_users.length
    let sql_staff_roles = await query("select id,name,color from roles where is_staff = 1")
    const role_ids = []
    for (const role of sql_staff_roles) {
        role_ids.push(role["id"])
    }
    let sql_staff_list = await query("select user_id,name,avatar,role from discord_oauth where role in (?)", [role_ids])
    
    const staff_list = []
    for (const staff of sql_staff_list) {
        let role_name = "Error"
        let role_color = "gray"
        for (const role of sql_staff_roles) {
            if (role["id"] === staff["role"]) {
                role_name = role["name"]
                role_color = role["color"]
            }
        }

        staff_list.push({
            username: staff["name"],
            avatar: staff["avatar"],
            role_name: role_name,
            role_color: role_color
        })
    }

    res.send({
        total_gdps: total_gdps,
        total_users: total_users,
        staff_list: staff_list
    })
})

app.get("/page/mygdps", async (req, res) => {
    const user_id = req.query["user_id"]
    const access_token = req.query["access_token"]

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    const gdps_list = []
    const owned_gdps = await query("select id,name,created_on,status from gdps where owner_id = ?", [user_id])
    for (const gdps of owned_gdps) {
        gdps_list.push({
            id: gdps["id"],
            name: gdps["name"],
            created_on: gdps["created_on"],
            status: gdps["status"],
            role: "Owner",
            username: null
        })
    }

    const managed_gdps_ids = await query("select gdps_id from subusers where user_id = ?", [user_id])
    if (managed_gdps_ids.length > 0) {
        const gdps_ids = []
        for (const gdps of managed_gdps_ids) {
            gdps_ids.push(gdps["gdps_id"])
        }
        const managed_gdps = await query("select id,name,created_on,status,owner_id from gdps where id in (?)", [gdps_ids])
        for (const gdps of managed_gdps) {
            const req_config = {
                url: `https://discord.com/api/users/${gdps["owner_id"]}`,
                method: "get",
                headers: {
                    "Authorization": `Bot ${config.bot_token}`
                }
            }
            let user_infos = await axios(req_config)
            user_infos = user_infos.data

            gdps_list.push({
                id: gdps["id"],
                name: gdps["name"],
                created_on: gdps["created_on"],
                status: gdps["status"],
                role: "Subuser",
                username: user_infos["username"]
            })
        }
    }

    res.send(gdps_list)
})

app.get("/page/gdps/management", async (req, res) => {
    const gdps_id = req.query["gdps_id"]
    const user_id = req.query["user_id"]
    const access_token = req.query["access_token"]

    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    const subusers = []
    const sql_subusers = await query("select user_id,perm_all,perm_management,perm_levels,perm_mappacks,perm_gauntlets,perm_quests,perm_users,perm_managemods,perm_seesentlevels,perm_seemodactions from subusers where gdps_id = ?", [gdps_id])
    for (const subuser of sql_subusers) {
        const user_data = {
            user_id: subuser["user_id"],
            user_name: "No name set",
            permissions: []
        }
        console.log(subuser["user_id"])

        const user_name = await query("select name from discord_oauth where user_id = ?", [subuser["user_id"]])
        if (user_name[0]["name"] !== "") {
            user_data["user_name"] = user_name[0]["name"]
        }

        perm_loop:
        for (const perm in subuser) {
            if (perm.startsWith("perm_") && subuser[perm] === 1) {
                switch (perm) {
                    case "perm_all": {
                        user_data["permissions"] = []
                        user_data["permissions"].push({
                            name: "All permissions",
                            color: "danger"
                        })
                        break perm_loop
                    } case "perm_management": {
                        user_data["permissions"].push({
                            name: "Management page",
                            color: "danger"
                        })
                        break
                    } case "perm_levels": {
                        user_data["permissions"].push({
                            name: "Levels",
                            color: "success"
                        })
                        break
                    } case "perm_mappacks": {
                        user_data["permissions"].push({
                            name: "Map packs",
                            color: "success"
                        })
                        break
                    } case "perm_gauntlets": {
                        user_data["permissions"].push({
                            name: "Gauntlets",
                            color: "success"
                        })
                        break
                    } case "perm_quests": {
                        user_data["permissions"].push({
                            name: "Quests",
                            color: "success"
                        })
                        break
                    } case "perm_users": {
                        user_data["permissions"].push({
                            name: "Users",
                            color: "success"
                        })
                        break
                    } case "perm_managemods": {
                        user_data["permissions"].push({
                            name: "Manage moderators",
                            color: "danger"
                        })
                        break
                    } case "perm_seesentlevels": {
                        user_data["permissions"].push({
                            name: "See sent levels",
                            color: "success"
                        })
                        break
                    } case "perm_seemodactions": {
                        user_data["permissions"].push({
                            name: "See mod actions",
                            color: "success"
                        })
                        break
                    }
                }
            }
        }
        subusers.push(user_data)
    }
    let gdps_infos = await query("select password from gdps where id = ?", [gdps_id])
    gdps_infos = gdps_infos[0]

    const req_response = {
        subusers: subusers
    }

    res.send(req_response)
})

app.get("/gdpsmanagementperm", async (req, res) => {
    const user_id = req.query["user_id"]
    const gdps_id = req.query["gdps_id"]

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}

    let gdps_infos = await query("select owner_id,name,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This GDPS doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] === user_id) {
        res.send({
            success: true,
            gdps_name: gdps_infos["name"],
            gdps_custom_url: gdps_infos["custom_url"]
        })
        return
    }

    let subuser_check = await query("select null from subusers where gdps_id = ? and user_id = ?", [gdps_id, user_id])
    if (subuser_check.length === 0) {
        res.send({
            success: false,
            message: "You don't have access to this GDPS."
        })
        return
    }

    res.send({
        "success": true,
        "gdps_name": gdps_infos["name"],
        gdps_custom_url: gdps_infos["custom_url"]
    })
})

app.post("/creategdps", async (req, res) => {
    const name = req.query["name"]
    const custom_url = req.query["custom-url"]
    const version = req.query["version"]
    const user_id = req.query["user_id"]
    const access_token = req.query["access_token"]
    const password = generate_pass()

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    let user_data = await query("select premium,gdps_limit from discord_oauth where user_id = ?", [user_id])
    if (user_data.length === 0) {
        res.send({ success: false, message: "User doesn't exist." })
        return
    }
    user_data = user_data[0]

    let gdps_authorised = 0
    if (user_data["premium"] === 1) {
        gdps_authorised++
    }
    gdps_authorised = gdps_authorised + user_data["gdps_limit"]

    const gdps_amount = await query("select null from gdps where owner_id = ?", [user_id])
    if (gdps_amount.length >= gdps_authorised) {
        res.send({ success: false, message: `You can't create more than ${gdps_authorised} gdps.` })
        return
    }

    var re = new RegExp(/^[a-zA-Z0-9]{1,20}$/);
    if (!re.test(name)) {
        res.send({ success: false, message: "Invalid name, please make sure that there are no special characters un the URL." })
        return
    }
    var re = new RegExp(/^[a-zA-Z][a-zA-Z0-9]{1,11}$/);
    if (!re.test(custom_url)) {
        res.send({ success: false, message: "Invalid custom URL, please make sure that there are no special characters un the URL and that the url doesn't start with a number." })
        return
    }

    if (custom_url === "www") {
        res.send({ success: false, message: "The custom url can't be www." })
        return
    }

    const existing_check = await query("select null from gdps where custom_url = ?", [custom_url])
    if (existing_check.length > 0) {
        res.send({ success: false, message: "This custom URL is already taken, please choose another one." })
        return
    }

    const current_time = Math.floor(Date.now() / 1000)
    const gdps = await query("insert into gdps (owner_id,name,custom_url,version,password,created_on) values (?,?,?,?,?,?)", [user_id, name, custom_url, version, password, current_time])

    var slash_count = ""
    var reverse_slash_count = ""
    if (custom_url.length < 19) {
        while (slash_count.length < 19 - custom_url.length) {
            slash_count = `${slash_count}/`
            reverse_slash_count = `${reverse_slash_count}\\/`
        }
    }

    const config_content = dedent`
    server {
        listen 443 ssl http2;
	    listen [::]:443 ssl http2;
        ssl_certificate /etc/nginx/certificates/ps-cloudflare.pem;
        ssl_certificate_key /etc/nginx/certificates/ps-cloudflare.key;
        server_name ${custom_url}.ps.fhgdps.com;
        root /var/www/gdps/${custom_url};
        index index.php index.html index.htm;
        autoindex on;

        location / {
            try_files $uri $uri/ =404;
        }
        
        location ~ \.php$ {
            try_files $uri =404;
            fastcgi_split_path_info ^(.+\.php)(/.+)$;
            fastcgi_pass unix:/var/run/php/${custom_url}.sock;
            fastcgi_index index.php;
            fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
            include fastcgi_params;
        }
    }`

    fs.writeFileSync(`/home/gdps/nginx_configs/${custom_url}.conf`, config_content, { flag: "w" });

    const fpm_config_content = dedent`
    [${custom_url}]
    user = gdps_${custom_url}
    group = gdps_${custom_url}
    listen = /var/run/php/${custom_url}.sock
    listen.owner = www-data
    listen.group = www-data
    php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen,curl_exec,curl_multi_exec,parse_ini_file,show_source,dl,setenv
    php_admin_value[open_basedir] = /var/www/gdps/${custom_url}
    php_admin_flag[allow_url_fopen] = off
    pm = dynamic
    pm.max_children = 5
    pm.start_servers = 2
    pm.min_spare_servers = 1
    pm.max_spare_servers = 3
    chdir = /var/www/gdps/${custom_url}/
    `

    fs.writeFileSync(`/etc/php/7.4/fpm/pool.d/${custom_url}.conf`, fpm_config_content, { flag: "w" });

    res.send({success: true})

    console.log(`Creating a new GDPS named ${name}.`)
    await createGDPS(custom_url, name, version, password, query)
    await exec(`ln -s /home/gdps/nginx_configs/${custom_url}.conf /etc/nginx/sites-enabled/`)
    await exec("service nginx reload")
    await exec("service php7.4-fpm reload")
    await query("update gdps set status = 1 where id = ?", [gdps.insertId])
    console.log(`Finished the creation of the GDPS named ${name}.`)
})

app.post("/createdl", async (req, res) => {
    const api_key = req.body["key"]
    const name = req.body["name"]
    const curl = req.body["curl"]
    const version = req.body["version"]
    if (api_key !== "F8fY5CQ6q5Bnc986igTR4n") {
        res.send("no")
        return
    }

    res.send("ok")
    await createAndroidDownload(curl, name, version)
    console.log("finished")
})

app.get("/getgdpspassword", async (req, res) => {
    const access_token = req.query["access_token"]
    const user_id = req.query["user_id"]
    const gdps_id = req.query["gdps_id"]
    res.set("Access-Control-Allow-Origin", config.allow_origin);

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    let gdps_infos = await query("select owner_id,password from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select perm_all,perm_management from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_management"] !== 1 && perm_check["perm_all"] === 0) {
            res.send({
                success: false,
                message: "You don't have permission to copy the password."
            })
            return
        }
    }

    res.send({
        success: true,
        password: gdps_infos["password"]
    })
    console.log(`User ${user_id} copied the password of a GDPS with the id ${gdps_id}.`)
})

app.get("/status", async (req, res) => {
    res.status(200)
    res.send("ok")
})

app.all("/addsubuser", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const subuser_id = req.body["subuser_id"]
    const allPerms = req.body["allPerms"]
    const managementPerm = req.body["managementPerm"]
    const manageLevels = req.body["manageLevels"]
    const manageMapPacks = req.body["manageMapPacks"]
    const manageGauntlets = req.body["manageGauntlets"]
    const manageQuests = req.body["manageQuests"]
    const manageUsers = req.body["manageUsers"]
    const manageModerators = req.body["manageModerators"]
    const seeSentLevels = req.body["seeSentLevels"]
    const seeModActions = req.body["seeModActions"]
    res.set("Access-Control-Allow-Origin", config.allow_origin);
    res.set("Access-Control-Allow-Headers", config.allow_origin);

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (user_id === subuser_id) {res.send({ success: false, message: "You can't add yourself as a subuser.." }); return}
    if (subuser_id === undefined || subuser_id === "") {res.send({ success: false, message: "Subuser id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}
    if (!Number.isInteger(allPerms) || allPerms > 1 || allPerms < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(managementPerm) || managementPerm > 1 || managementPerm < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageLevels) || manageLevels > 1 || manageLevels < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageMapPacks) || manageMapPacks > 1 || manageMapPacks < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageGauntlets) || manageGauntlets > 1 || manageGauntlets < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageQuests) || manageQuests > 1 || manageQuests < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageUsers) || manageUsers > 1 || manageUsers < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageModerators) || manageModerators > 1 || manageModerators < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(seeSentLevels) || seeSentLevels > 1 || seeSentLevels < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(seeModActions) || seeModActions > 1 || seeModActions < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    if (
        allPerms === 0 &&
        managementPerm === 0 &&
        manageLevels === 0 &&
        manageMapPacks === 0 &&
        manageGauntlets === 0 &&
        manageQuests === 0 &&
        manageUsers === 0 &&
        manageModerators === 0 &&
        seeSentLevels === 0 &&
        seeModActions === 0
    ) {
        res.send({
            success: false,
            message: "You need to select at least one permission."
        })
        return
    }

    const own_gdps = await query("select null from gdps where id = ? and owner_id = ?", [gdps_id, user_id])
    if (own_gdps.length === 0) {
        res.send({
            success: false,
            message: "You can't add subusers on this GDPS."
        })
        return
    }

    const user_exist_check = await query("select null from discord_oauth where user_id = ?", [subuser_id])
    if (user_exist_check.length === 0) {
        res.send({
            success: false,
            message: "This user doesn't have an account on GDPSFH."
        })
        return
    }

    const user_check = await query("select null from subusers where gdps_id = ? and user_id = ?", [gdps_id, subuser_id])
    if (user_check.length > 0) {
        res.send({
            success: false,
            message: "This user is already a subuser."
        })
        return
    }

    await query("insert into subusers (gdps_id,user_id,perm_all,perm_management,perm_levels,perm_mappacks,perm_gauntlets,perm_quests,perm_users,perm_managemods,perm_seesentlevels,perm_seemodactions) values (?,?,?,?,?,?,?,?,?,?,?,?)", [gdps_id, subuser_id, allPerms, managementPerm, manageLevels, manageMapPacks, manageGauntlets, manageQuests, manageUsers, manageModerators, seeSentLevels, seeModActions])
    res.send({
        success: true
    })
    console.log(`${user_id} added ${subuser_id} as a subuser on the GDPS with the id ${gdps_id}.`)
})

app.all("/deletesubuser", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const subuser_id = req.body["subuser_id"]
    res.set("Access-Control-Allow-Origin", config.allow_origin);
    res.set("Access-Control-Allow-Headers", config.allow_origin);

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (subuser_id === undefined || subuser_id === "") {res.send({ success: false, message: "Subuser id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    const own_gdps = await query("select null from gdps where id = ? and owner_id = ?", [gdps_id, user_id])
    if (own_gdps.length === 0) {
        res.send({
            success: false,
            message: "You can't remove subusers on this GDPS."
        })
        return
    }

    const user_exist_check = await query("select null from discord_oauth where user_id = ?", [subuser_id])
    if (user_exist_check.length === 0) {
        res.send({
            success: false,
            message: "This user doesn't have an account on GDPSFH."
        })
        return
    }

    await query("delete from subusers where gdps_id = ? and user_id = ?", [gdps_id, subuser_id])
    res.send({
        success: true
    })
    console.log(`${user_id} removed the subuser ${subuser_id} on the GDPS with the id ${gdps_id}.`)
})

async function is_token_valid(user_id, token) {
    const check = await query("select null from discord_oauth where user_id = ? and access_token = ?", [user_id, token])
    if (check.length === 0) {
        return false
    }

    return true
}

function generate_pass() {
    const first = Math.random().toString(36).substr(2);
    const second = Math.random().toString(36).substr(2);
    return first + second;
};

app.listen(config.port, async function () {
    console.log("[API] Started!")
})