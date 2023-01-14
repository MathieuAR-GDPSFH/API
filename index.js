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
const cors = require('cors')
const {IP2Proxy} = require("ip2proxy-nodejs");
const { createGDPS, createAndroidDownload, createPcDownload, deleteGDPS, forceDeleteGDPS } = require("./utils")

var app = express()
app.use(bp.json())
app.use(bp.urlencoded({ extended: true }))
app.set('trust proxy', true)
app.use(cors())

var sql_conn = mysql.createPool({
    connectionLimit : 10,
    host: config.mysql.host,
    user: config.mysql.username,
    password: config.mysql.password,
    database: config.mysql.database,
    charset: 'utf8mb4'
});
const query = util.promisify(sql_conn.query).bind(sql_conn);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let ip2proxy = new IP2Proxy();

app.post("/discord/oauth/code", async (req, res) => {
    const code = req.query["code"]
    const ip = req.query["ip"]

    const is_vpn = checkVpnIp(ip)
    if (is_vpn === "error") {
        res.send({
            success: false,
            message: "An internal error occured"
        })
        return
    } else if (is_vpn === 1) {
        res.send({
            success: false,
            message: "No VPN allowed."
        })
        return
    }
    
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
        res.send({
            success: false,
            message: "An error occured while trying to contact the discord API."
        })
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
        res.send({
            success: false,
            message: "An error occured while trying to contact the discord API."
        })
        return
    }

    const avatar = `https://cdn.discordapp.com/avatars/${user_data["id"]}/${user_data["avatar"]}`
    const access_token = crypto.randomBytes(64).toString('hex')

    const req_response = {
        success: true,
        user_id: user_data["id"],
        username: user_data["username"],
        avatar: avatar,
        access_token: access_token,
        staff_permissions: []
    }

    var sql_data = await query("select role from discord_oauth where user_id = ?", [user_data["id"]])
    if (sql_data.length === 0) {
        const current_time = Math.floor(Date.now() / 1000)
        await query("insert into discord_oauth (user_id,name,avatar,token,token_expire,refresh_token,created_on,ip,access_token) values (?,?,?,?,?,?,?,?,?)", [user_data["id"], user_data["username"], avatar, oauth_data["access_token"], current_time + oauth_data["expires_in"], oauth_data["refresh_token"], current_time, ip, access_token])
    } else if (sql_data.length === 1) {
        await query("update discord_oauth set name = ?, avatar = ?, access_token = ?, ip = ? where user_id = ?", [user_data["username"], avatar, access_token, ip, user_data["id"]])

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
            let user = await query("select name from discord_oauth where user_id = ?", [gdps["owner_id"]])
            user = user[0]

            gdps_list.push({
                id: gdps["id"],
                name: gdps["name"],
                created_on: gdps["created_on"],
                status: gdps["status"],
                role: "Subuser",
                username: user["name"]
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
    const sql_subusers = await query("select user_id,perm_all,perm_copygdpspass,perm_levels,perm_mappacks,perm_gauntlets,perm_quests,perm_users,perm_managemods,perm_seesentlevels,perm_seemodactions,perm_manageroles from subusers where gdps_id = ?", [gdps_id])
    for (const subuser of sql_subusers) {
        const user_data = {
            user_id: subuser["user_id"],
            user_name: "No name set",
            permissions: []
        }

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
                    } case "perm_copygdpspass": {
                        user_data["permissions"].push({
                            name: "Copy GDPS password",
                            color: "danger"
                        })
                        break
                    } case "perm_manageroles": {
                        user_data["permissions"].push({
                            name: "Manage GDPS roles",
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

app.get("/page/gdps/moderators", async (req, res) => {
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

    let gdps_infos = await query("select owner_id,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select perm_all,perm_managemods from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_managemods"] !== 1 && perm_check["perm_all"] === 0) {
            res.send({
                success: false,
                message: "You don't have permission to manage moderators."
            })
            return
        }
    }

    const gdps_curl = gdps_infos["custom_url"]
    const gdps_roles = []
    const sql_gdps_roles = await query(`select * from gdps_${gdps_curl}.roles order by priority desc`)
    if (sql_gdps_roles.length > 0) {
        for (const role of sql_gdps_roles) {
            gdps_roles.push({
                id: role["roleID"],
                name: role["roleName"],
                badge: role["modBadgeLevel"],
                comment_color: role["commentColor"],
                priority: role["priority"],
                default: role["isDefault"],
                permissions: []
            })
        }
    }

    const gdps_moderators = []
    const gdps_moderator_ids = []
    const sql_gdps_roleassigns = await query(`select * from gdps_${gdps_curl}.roleassign`)
    if (sql_gdps_roleassigns.length > 0) {
        for (const roleassign of sql_gdps_roleassigns) {
            gdps_moderator_ids.push(roleassign["accountID"])
        }

        const sql_moderators = await query(`select userName,accountID from gdps_${gdps_curl}.accounts where accountID in (?)`, [gdps_moderator_ids])
        for (const mod of sql_moderators) {
            let role_id
            let assign_id
            let role_name
            for (const roleassign of sql_gdps_roleassigns) {
                if (mod["accountID"] === roleassign["accountID"]) {
                    role_id = roleassign["roleID"]
                    assign_id = roleassign["assignID"]
                    break
                }
            }

            for (const role of gdps_roles) {
                if (role["id"] === role_id) {
                    role_name = role["name"]
                    break
                }
            }

            gdps_moderators.push({
                name: mod["userName"],
                role_name: role_name,
                role_id: role_id,
                assign_id: assign_id
            })
        }
    }

    res.send({
        roles: gdps_roles,
        moderators: gdps_moderators
    })
})

// app.get("/page/gdps/dashboard", async (req, res) => {
//     const access_token = req.query["access_token"]
//     const user_id = req.query["user_id"]
//     const gdps_id = req.query["gdps_id"]

//     if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
//     if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
//     if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}

//     const token_check = await is_token_valid(user_id, access_token)
//     if (!token_check) {
//         res.send({
//             success: false,
//             message: "Token check failed."
//         })
//         return
//     }

//     let gdps_infos = await query("select owner_id from gdps where id = ?", [gdps_id])
//     if (gdps_infos.length === 0) {
//         res.send({
//             success: false,
//             message: "This gdps doesn't exist."
//         })
//         return
//     }
//     gdps_infos = gdps_infos[0]

//     if (gdps_infos["owner_id"] !== user_id) {
//         const perm_check = await query("select null from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
//         if (perm_check.length === 0) {
//             res.send({
//                 success: false,
//                 message: "You don't have access to this gdps."
//             })
//             return
//         }
//     }

    
// })

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
    const name = req.body["name"]
    const custom_url = req.body["custom_url"]
    const version = req.body["version"]
    const user_id = req.body["user_id"]
    const access_token = req.body["access_token"]
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
        res.send({ success: false, message: "Invalid name, please make sure that there are no special characters and no spaces un the name." })
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
    php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen,curl_multi_exec,parse_ini_file,show_source,dl,setenv,putenv
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
    await createGDPS(custom_url, password, query)
    await exec(`ln -s /home/gdps/nginx_configs/${custom_url}.conf /etc/nginx/sites-enabled/`)
    await exec("service nginx reload")
    await exec("service php7.4-fpm reload")
    await query("update gdps set status = 1 where id = ?", [gdps.insertId])
    console.log(`Finished the creation of the GDPS named ${name}.`)
})

app.get("/getgdpspassword", async (req, res) => {
    const access_token = req.query["access_token"]
    const user_id = req.query["user_id"]
    const gdps_id = req.query["gdps_id"]

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
        let perm_check = await query("select perm_all,perm_copygdpspass from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_copygdpspass"] !== 1 && perm_check["perm_all"] === 0) {
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

app.post("/addsubuser", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const subuser_id = req.body["subuser_id"]
    const allPerms = req.body["allPerms"]
    const copyPass = req.body["copyPass"]
    const manageLevels = req.body["manageLevels"]
    const manageMapPacks = req.body["manageMapPacks"]
    const manageGauntlets = req.body["manageGauntlets"]
    const manageQuests = req.body["manageQuests"]
    const manageUsers = req.body["manageUsers"]
    const manageModerators = req.body["manageModerators"]
    const seeSentLevels = req.body["seeSentLevels"]
    const seeModActions = req.body["seeModActions"]
    const manageRoles = req.body["manageRoles"]

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (user_id === subuser_id) {res.send({ success: false, message: "You can't add yourself as a subuser.." }); return}
    if (subuser_id === undefined || subuser_id === "") {res.send({ success: false, message: "Subuser id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}
    if (!Number.isInteger(allPerms) || allPerms > 1 || allPerms < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(copyPass) || copyPass > 1 || copyPass < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageLevels) || manageLevels > 1 || manageLevels < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageMapPacks) || manageMapPacks > 1 || manageMapPacks < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageGauntlets) || manageGauntlets > 1 || manageGauntlets < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageQuests) || manageQuests > 1 || manageQuests < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageUsers) || manageUsers > 1 || manageUsers < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageModerators) || manageModerators > 1 || manageModerators < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(seeSentLevels) || seeSentLevels > 1 || seeSentLevels < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(seeModActions) || seeModActions > 1 || seeModActions < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}
    if (!Number.isInteger(manageRoles) || manageRoles > 1 || manageRoles < 0) {res.send({ success: false, message: "Wrong or missing permission." }); return}

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
        copyPass === 0 &&
        manageLevels === 0 &&
        manageMapPacks === 0 &&
        manageGauntlets === 0 &&
        manageQuests === 0 &&
        manageUsers === 0 &&
        manageModerators === 0 &&
        seeSentLevels === 0 &&
        seeModActions === 0 &&
        manageRoles === 0
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

    await query("insert into subusers (gdps_id,user_id,perm_all,perm_copygdpspass,perm_levels,perm_mappacks,perm_gauntlets,perm_quests,perm_users,perm_managemods,perm_seesentlevels,perm_seemodactions,perm_manageroles) values (?,?,?,?,?,?,?,?,?,?,?,?,?)", [gdps_id, subuser_id, allPerms, copyPass, manageLevels, manageMapPacks, manageGauntlets, manageQuests, manageUsers, manageModerators, seeSentLevels, seeModActions, manageRoles])
    res.send({
        success: true
    })
    console.log(`${user_id} added ${subuser_id} as a subuser on the GDPS with the id ${gdps_id}.`)
})

app.post("/deletesubuser", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const subuser_id = req.body["subuser_id"]

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

app.delete("/deletegdps", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]

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

    let own_gdps = await query("select owner_id from gdps where id = ?", [gdps_id])
    if (own_gdps.length === 0) {
        res.send({
            success: false,
            message: "This GDPS doesn't exist."
        })
        return
    }
    own_gdps = own_gdps[0]

    if (own_gdps["owner_id"] !== user_id) {
        res.send({
            success: false,
            message: "Only the GDPS owner can delete the GDPS."
        })
        return
    }
    console.log(`Started deletion of the GDPS with the id ${gdps_id}.`)

    let custom_url = await query("select custom_url from gdps where id = ?", [gdps_id])
    custom_url = custom_url[0]["custom_url"]

    await deleteGDPS(custom_url, gdps_id, query)
    res.send({
        success: true
    })
    console.log(`The GDPS with the id ${gdps_id} is now deleted.`)
})

app.post("/createRole", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const gdps_name = req.body["gdps_name"]
    const badge = req.body["badge"]
    let priority = req.body["priority"]
    let comment_color = req.body["comment_color"]
    const rateCommand = req.body["rateCommand"]
    const featureCommand = req.body["featureCommand"]
    const epicCommand = req.body["epicCommand"]
    const unEpicCommand = req.body["unEpicCommand"]
    const verifyCoinsCommand = req.body["verifyCoinsCommand"]
    const dailyCommand = req.body["dailyCommand"]
    const weeklyCommand = req.body["weeklyCommand"]
    const deleteCommand = req.body["deleteCommand"]
    const setAccCommand = req.body["setAccCommand"]
    const renameCommandOwn = req.body["renameCommandOwn"]
    const renameCommandAll = req.body["renameCommandAll"]
    const passCommandOwn = req.body["passCommandOwn"]
    const passCommandAll = req.body["passCommandAll"]
    const descriptionCommandOwn = req.body["descriptionCommandOwn"]
    const descriptionCommandAll = req.body["descriptionCommandAll"]
    const publicCommandOwn = req.body["publicCommandOwn"]
    const publicCommandAll = req.body["publicCommandAll"]
    const unlistCommandOwn = req.body["unlistCommandOwn"]
    const unlistCommandAll = req.body["unlistCommandAll"]
    const shareCpCommandOwn = req.body["shareCpCommandOwn"]
    const shareCpCommandAll = req.body["shareCpCommandAll"]
    const songCommandOwn = req.body["songCommandOwn"]
    const songCommandAll = req.body["songCommandAll"]
    const rateDemon = req.body["rateDemon"]
    const rateStars = req.body["rateStars"]
    const rateDifficulty = req.body["rateDifficulty"]
    const requestMod = req.body["requestMod"]
    const suggestRate = req.body["suggestRate"]
    const deleteComment = req.body["deleteComment"]
    const leaderboardBan = req.body["leaderboardBan"]
    const createPackTool = req.body["createPackTool"]
    const createQuestsTool = req.body["createQuestsTool"]
    const modActionsTool = req.body["modActionsTool"]
    const suggestListTool = req.body["suggestListTool"]
    const dashboardModTools = req.body["dashboardModTools"]
    const modIpCategory = req.body["modIpCategory"]
    const profileCommandDiscord = req.body["profileCommandDiscord"]

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}
    if (gdps_name === undefined || gdps_name === "") {res.send({ success: false, message: "Name is required." }); return}
    if (badge === undefined || badge === "") {res.send({ success: false, message: "Badge is required." }); return}
    if (comment_color === undefined) {res.send({ success: false, message: "Comment color required." }); return}
    if (priority === undefined || priority === "") {res.send({ success: false, message: "Priority is required." }); return}
    priority = Number(priority)
    if (!Number.isInteger(priority)) {res.send({ success: false, message: "Priority has to be a number." }); return}
    if (priority.length > 11) {res.send({ success: false, message: "Priority can't be over 11 numbers." }); return}
    if (gdps_name.length > 50) {res.send({ success: false, message: "Name can't be over 50 Characters." }); return}

    if (comment_color === "") {
        comment_color = "000,000,000"
    } else {
        comment_color = hexToRgb(comment_color)
    }

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    let gdps_infos = await query("select owner_id,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This GDPS doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select perm_all,perm_manageroles from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_manageroles"] !== 1 && perm_check["perm_all"] === 0) {
            res.send({
                success: false,
                message: "You don't have permission to create roles."
            })
            return
        }
    }

    await query(`insert into gdps_${gdps_infos["custom_url"]}.roles (priority,roleName,commandRate,commandFeature,commandEpic,commandUnepic,commandVerifycoins,commandDaily,commandWeekly,commandDelete,commandSetacc,commandRenameOwn,commandRenameAll,commandPassOwn,commandPassAll,commandDescriptionOwn,commandDescriptionAll,commandPublicOwn,commandPublicAll,commandUnlistOwn,commandUnlistAll,commandSharecpOwn,commandSharecpAll,commandSongOwn,commandSongAll,profilecommandDiscord,actionRateDemon,actionRateStars,actionRateDifficulty,actionRequestMod,actionSuggestRating,actionDeleteComment,toolLeaderboardsban,toolPackcreate,toolQuestsCreate,toolModactions,toolSuggestlist,dashboardModTools,modipCategory,commentColor,modBadgeLevel) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [priority, gdps_name, rateCommand, featureCommand, epicCommand, unEpicCommand, verifyCoinsCommand, dailyCommand, weeklyCommand, deleteCommand, setAccCommand, renameCommandOwn, renameCommandAll, passCommandOwn, passCommandAll, descriptionCommandOwn, descriptionCommandAll, publicCommandOwn, publicCommandAll, unlistCommandOwn, unlistCommandAll, shareCpCommandOwn, shareCpCommandAll, songCommandOwn, songCommandAll, profileCommandDiscord, rateDemon, rateStars, rateDifficulty, requestMod, suggestRate, deleteComment, leaderboardBan, createPackTool, createQuestsTool, modActionsTool, suggestListTool, dashboardModTools, modIpCategory, comment_color, badge])
    res.send({
        success: true
    })
})

app.delete("/deleterole", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const role_id = req.body["role_id"]

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (role_id === undefined || role_id === "") {res.send({ success: false, message: "Role id required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    let gdps_infos = await query("select owner_id,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select perm_all,perm_manageroles from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_manageroles"] !== 1 && perm_check["perm_all"] === 0) {
            res.send({
                success: false,
                message: "You don't have permission to delete roles."
            })
            return
        }
    }

    await query(`delete from gdps_${gdps_infos["custom_url"]}.roles where roleID = ?`, [role_id])
    await query(`delete from gdps_${gdps_infos["custom_url"]}.roleassign where roleID = ?`, [role_id])
    res.send({
        success: true
    })
})

app.get("/getgdpsusers", async (req, res) => {
    const access_token = req.query["access_token"]
    const user_id = req.query["user_id"]
    const gdps_id = req.query["gdps_id"]
    const search_username = req.query["search_username"]

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (search_username === undefined || search_username === "") {res.send({ success: false, message: "User name search required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    let gdps_infos = await query("select owner_id,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select perm_all,perm_managemods from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_managemods"] !== 1 && perm_check["perm_all"] === 0) {
            res.send({
                success: false,
                message: "You don't have permission to add moderators."
            })
            return
        }
    }

    const req_resp = []
    const gdps_users = await query(`select userName,accountID from gdps_${gdps_infos["custom_url"]}.accounts where userName like ? limit 10`, [`%${search_username}%`])
    for (const user of gdps_users) {
        req_resp.push({
            text: user["userName"],
            id: user["accountID"]
        })
    }
    res.send({
        success: true,
        users: req_resp
    })
})

app.post("/addmoderator", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const mod_id = req.body["mod_id"]
    const role_id = req.body["role_id"]

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (mod_id === undefined || mod_id === "") {res.send({ success: false, message: "Moderator id required." }); return}
    if (role_id === undefined || role_id === "") {res.send({ success: false, message: "Role required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    let gdps_infos = await query("select owner_id,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select perm_all,perm_managemods from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_managemods"] !== 1 && perm_check["perm_all"] === 0) {
            res.send({
                success: false,
                message: "You don't have permission to add moderators."
            })
            return
        }
    }

    const mod_check = await query(`select null from gdps_${gdps_infos["custom_url"]}.roleassign where accountID = ?`, [mod_id])
    if (mod_check.length > 0) {
        res.send({
            success: false,
            message: "This user is already has a role."
        })
        return
    }

    await query(`insert into gdps_${gdps_infos["custom_url"]}.roleassign (roleID,accountID) values (?,?)`, [role_id, mod_id])
    res.send({
        success: true
    })
})

app.delete("/removemoderator", async (req, res) => {
    const access_token = req.body["access_token"]
    const user_id = req.body["user_id"]
    const gdps_id = req.body["gdps_id"]
    const assign_id = req.body["assign_id"]

    if (user_id === undefined || user_id === "") {res.send({ success: false, message: "User id required." }); return}
    if (gdps_id === undefined || gdps_id === "") {res.send({ success: false, message: "GDPS id required." }); return}
    if (assign_id === undefined || assign_id === "") {res.send({ success: false, message: "Moderator id required." }); return}
    if (access_token === undefined || access_token === "") {res.send({ success: false, message: "Access token required." }); return}

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    let gdps_infos = await query("select owner_id,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select perm_all,perm_managemods from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
        perm_check = perm_check[0]

        if (perm_check["perm_managemods"] !== 1 && perm_check["perm_all"] === 0) {
            res.send({
                success: false,
                message: "You don't have permission to remove moderators."
            })
            return
        }
    }

    await query(`delete from gdps_${gdps_infos["custom_url"]}.roleassign where assignID = ?`, [assign_id])
    res.send({
        success: true
    })
})

app.get("/getpcdownload", async (req, res) => {
    const access_token = req.query["access_token"]
    const user_id = req.query["user_id"]
    const gdps_id = req.query["gdps_id"]

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

    let gdps_infos = await query("select owner_id,custom_url,name,version from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select null from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
    }

    const on_cooldown = await cooldown_check(user_id, `getdl-pc-${gdps_id}`, 1800)
    if (on_cooldown[0] === true) {
        var minutes = Math.floor(on_cooldown[1] / 60);
        var seconds = on_cooldown[1] % 60;

        var output
        if (minutes === 0) {
            output = `${seconds} seconds`
        } else {
            output = `${minutes} minutes and ${seconds} seconds`
        }

        res.send({
            success: false,
            message: `PC generation on cooldown, you can use it again in ${output}`
        })
        return
    }

    await createPcDownload(gdps_infos["custom_url"], gdps_infos["name"], gdps_infos["version"])
    res.send({
        success: true,
        download: `https://download.fhgdps.com/${gdps_infos["custom_url"]}/${gdps_infos["name"]}.zip`
    })

    await delay(300 * 1000)
    await exec(`rm -rf /home/gdps/downloads/${gdps_infos["custom_url"]}/${gdps_infos["name"]}.zip`)
})

app.get("/getandroiddownload", async (req, res) => {
    const access_token = req.query["access_token"]
    const user_id = req.query["user_id"]
    const gdps_id = req.query["gdps_id"]

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

    let gdps_infos = await query("select owner_id,custom_url,name,version from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    if (gdps_infos["owner_id"] !== user_id) {
        let perm_check = await query("select null from subusers where user_id = ? and gdps_id = ?", [user_id, gdps_id])
        if (perm_check.length === 0) {
            res.send({
                success: false,
                message: "You don't have access to this gdps."
            })
            return
        }
    }

    const on_cooldown = await cooldown_check(user_id, `getdl-android-${gdps_id}`, 1800)
    if (on_cooldown[0] === true) {
        var minutes = Math.floor(on_cooldown[1] / 60);
        var seconds = on_cooldown[1] % 60;

        var output
        if (minutes === 0) {
            output = `${seconds} seconds`
        } else {
            output = `${minutes} minutes and ${seconds} seconds`
        }

        res.send({
            success: false,
            message: `Android generation on cooldown, you can use it again in ${output}`
        })
        return
    }

    await createAndroidDownload(gdps_infos["custom_url"], gdps_infos["name"], gdps_infos["version"])
    res.send({
        success: true,
        download: `https://download.fhgdps.com/${gdps_infos["custom_url"]}/${gdps_infos["name"]}.apk`
    })

    await delay(300 * 1000)
    await exec(`rm -rf /home/gdps/downloads/${gdps_infos["custom_url"]}/${gdps_infos["name"]}.apk`)
})

app.delete("/forcedeletegdps", async (req, res) => {
    const access_token = req.query["access_token"]
    const user_id = req.query["user_id"]
    const gdps_id = req.query["gdps_id"]

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

    if (user_id !== "195598321501470720") {
        res.send({
            success: false,
            message: "You don't have permission to do this."
        })
        return
    }

    let gdps_infos = await query("select id,custom_url from gdps where id = ?", [gdps_id])
    if (gdps_infos.length === 0) {
        res.send({
            success: false,
            message: "This gdps doesn't exist."
        })
        return
    }
    gdps_infos = gdps_infos[0]

    await forceDeleteGDPS(gdps_infos["custom_url"], gdps_infos["id"], query)
    res.send({
        success: true
    })
})

app.post("/resetallpass", async (req, res) => {
    const key = req.query["key"]
    const access_token = req.query["access_token"]
    const user_id = req.query["user_id"]

    const token_check = await is_token_valid(user_id, access_token)
    if (!token_check) {
        res.send({
            success: false,
            message: "Token check failed."
        })
        return
    }

    if (user_id !== "195598321501470720" && user_id !== "180790976128745472") {
        res.send("no")
        return
    }

    if (key !== config.api_keys.reset_all_pass) {
        res.send("no")
        return
    }

    const all_gdps = await query("select id,custom_url from gdps")
    for (const gdps of all_gdps) {
        const custom_url = gdps["custom_url"]
        const password = generate_pass()
        const config = dedent`<?php
                              $servername = "127.0.0.1";
                              $port = 3306;
                              $username = "gdps_${custom_url}";
                              $password = "${password}";
                              $dbname = "gdps_${custom_url}";
                              ?>`

        try {
            fs.writeFileSync(`/var/www/gdps/${custom_url}/config/connection.php`, config, { flag: 'w' });
        } catch {}
        await query(`alter user 'gdps_${custom_url}'@'localhost' identified by '${password}'`)
        await query("update gdps set password = ? where id = ?", [password, gdps["id"]])
        await exec(`usermod --password $(echo ${password} | openssl passwd -1 -stdin) gdps_${custom_url}`)
    }

    res.send({
        success: true
    })
})

// app.post("/deleteallgdpsadmin", async (req, res) => {
//     const key = req.body["key"]

//     if (key !== "sjidgvhderljgiuesliugheqrzklghjnqeryhliomytgzryg5454j6fygj26ty") {
//         res.send("no")
//         return
//     }

//     let custom_url = await query("select id,custom_url from gdps")
//     for (const gdps of custom_url) {
//         await deleteGDPS(gdps["custom_url"], gdps["id"], query)
//     }
//     res.send({
//         success: true
//     })
// })

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
}

function hexToRgb(hex) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`
}

async function cooldown_check(user_id, cooldown_type, cooldown_length) {
    const cooldown_check = await query("select timestamp from cooldowns where user_id = ? and type = ?", [user_id, cooldown_type])
    const current_time = Math.floor(Date.now() / 1000)
    if (cooldown_check.length === 0) {
        await query("insert into cooldowns (user_id, type, timestamp) values (?,?,?)", [user_id, cooldown_type, current_time])
        return false
    }

    const user_cooldown = cooldown_check[0]["timestamp"]
    if (user_cooldown + cooldown_length > current_time) {
        return [true, user_cooldown + cooldown_length - current_time]
    }
    await query("update cooldowns set timestamp = ? where user_id = ? and type = ?", [current_time, user_id, cooldown_type])
    return [false]
}

function checkVpnIp(ip) {
    if (ip2proxy.open("./vpn_detector.bin") == 0) {
        return ip2proxy.isProxy(ip)
    } else {
        console.log("Error reading BIN file.");
    }
    ip2proxy.close();
    return "error"
}

process.on("uncaughtException", err => {
    console.log('Caught exception: ' + err.stack);
})

app.listen(config.port, async function () {
    console.log("[API] Started!")
})