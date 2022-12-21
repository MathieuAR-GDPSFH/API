const util = require('util');
const exec = util.promisify(require("child_process").exec);
const dedent = require('dedent')
const fs = require("fs")

module.exports.createGDPS = async function (custom_url, name, version, password, query) {
    var slash_count = ""
    var mobile_folder_name = custom_url
    if (custom_url.length < 11) {
        while (slash_count.length < 11 - custom_url.length) {
            slash_count = `${slash_count}/`
            mobile_folder_name = `${mobile_folder_name}0`
        }
    }
    mobile_folder_name + `${mobile_folder_name}0`

    await exec(`mkdir /var/www/gdps/${custom_url}`)
    await exec(`cp -r /home/gdps/GDPS_Creator/server_files/* /var/www/gdps/${custom_url}`)
    await exec(`chmod 777 -R /var/www/gdps/${custom_url}/data/*`)
    await exec(`chmod 666 /var/www/gdps/${custom_url}/config/dailyChests.php`)

    await query(`CREATE USER 'gdps_${custom_url}'@'localhost' IDENTIFIED BY '${password}'`)
    await query(`CREATE DATABASE gdps_${custom_url}`)
    await query(`GRANT ALL PRIVILEGES ON gdps_${custom_url}.* TO 'gdps_${custom_url}'@'localhost'`)
    await exec(`mysql -u root gdps_${custom_url} < /home/gdps/GDPS_Creator/database.sql`)

    const config = dedent`<?php
                          $servername = "127.0.0.1";
                          $port = 3306;
                          $username = "gdps_${custom_url}";
                          $password = "${password}";
                          $dbname = "gdps_${custom_url}";
                          ?>`

    fs.writeFileSync(`/var/www/gdps/${custom_url}/config/connection.php`, config, { flag: 'w' });

    await exec(`useradd -b /var/www/gdps/${custom_url} -d /var/www/gdps/${custom_url} -s /bin/false -p $(openssl passwd -crypt ${password}) gdps_${custom_url}`)
    await exec(`usermod -a -G www-data,gdps_${custom_url} gdps_${custom_url}`)
    await exec(`chown -R gdps_${custom_url}:www-data /var/www/gdps/${custom_url}`)

    const gdps_url = `https://${custom_url}.ps.fhgdps.com${slash_count}`
    const gdps_base64_url = Buffer.from(gdps_url).toString('base64').replaceAll("=", "")
    const boomlings_url = "http://www.boomlings.com/database"
    const boomlings_base64_url = "aHR0cDovL3d3dy5ib29tbGluZ3MuY29tL2RhdGFiYXNl"

    fs.mkdirSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}`);
    await exec(`cp -r /home/gdps/GDPS_Creator/Game/PC/Versions/${version}/* /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}`)
    const exe_content = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/GD.exe`, "latin1");
    const modified_exe = exe_content.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const buffer = Buffer.from(modified_exe, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/${name}.exe`, buffer);
    await exec(`rm /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/GD.exe`)
    await exec(`cd /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url} && zip -q -r /var/www/gdps/${custom_url}/download/${name}.zip *`)
    await exec(`rm -rf /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}`)

    await exec(`cp -r /home/gdps/GDPS_Creator/Game/Mobile/Versions/${version}/GD /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}`)

    const file1 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi/libcocos2dcpp.so`, "latin1");
    const file1_modified = file1.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file1_buffer = Buffer.from(file1_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi/libcocos2dcpp.so`, file1_buffer);

    const file2 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi-v7a/libcocos2dcpp.so`, "latin1");
    const file2_modified = file2.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file2_buffer = Buffer.from(file2_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi-v7a/libcocos2dcpp.so`, file2_buffer);

    const file3 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/x86/libcocos2dcpp.so`, "latin1");
    const file3_modified = file3.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file3_buffer = Buffer.from(file3_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/x86/libcocos2dcpp.so`, file3_buffer);

    await exec(`find /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/ -type f -exec sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" {} \\;`)
    await exec(`sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/AndroidManifest.xml`)
    await exec(`sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/original/AndroidManifest.xml`)
    
    const folder54 = fs.readdirSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump`)
    for (var file_index in folder54) {
        const file_name = folder54[file_index]
        const gfile = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump/${file_name}`, "latin1");
        const gfile_modified = gfile.replaceAll("com/robtopx/geometryjump", `com/mathieu/${mobile_folder_name}`)
        const gfile_buffer = Buffer.from(gfile_modified, 'latin1')
        fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump/${file_name}`, gfile_buffer);
    }
    
    fs.renameSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump`, `/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/${mobile_folder_name}`)
    const strings_file = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/res/values/strings.xml`, "utf-8");
    const strings_file_modified = strings_file.replaceAll("Geometry Dash", name)
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/res/values/strings.xml`, strings_file_modified);

    await exec(`cd /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/ && java -jar apktool.jar b ${custom_url}`)
    await exec(`mv /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/dist/GD.apk /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK/${custom_url}.apk`)
    await exec(`cd /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK && java -jar signapk.jar certificate.pem key.pk8 ${custom_url}.apk ${custom_url}-signed.apk && mv ${custom_url}-signed.apk /var/www/gdps/${custom_url}/download/${name}.apk`)
    await exec(`rm -rf /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}`)
    await exec(`rm /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK/${custom_url}.apk`)
}

module.exports.createPcDownload = async function (custom_url, name, version) {
    var slash_count = ""
    if (custom_url.length < 11) {
        while (slash_count.length < 11 - custom_url.length) {
            slash_count = `${slash_count}/`
        }
    }

    const gdps_url = `https://${custom_url}.ps.fhgdps.com${slash_count}`
    const gdps_base64_url = Buffer.from(`https://${custom_url}.ps.fhgdps.com${slash_count}`).toString('base64').replaceAll("=", "")
    const boomlings_url = "http://www.boomlings.com/database"
    const boomlings_base64_url = "aHR0cDovL3d3dy5ib29tbGluZ3MuY29tL2RhdGFiYXNl"

    fs.mkdirSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}`);
    fs.mkdirSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl`);
    try {
        fs.mkdirSync(`/var/www/gdps_tools/downloads/${custom_url}`);
    } catch {}
    await exec(`cp -r /home/gdps/GDPS_Creator/Game/PC/Versions/${version}/* /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl`)
    const exe_content = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl/GD.exe`, "latin1");
    const modified_exe = exe_content.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const buffer = Buffer.from(modified_exe, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl/${name}.exe`, buffer);
    await exec(`rm /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl/GD.exe`)
    await exec(`cd /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl && zip -q -r /var/www/gdps_tools/downloads/${custom_url}/${name}.zip *`)
    await exec(`rm -rf /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}`)
}

module.exports.createAndroidDownload = async function (custom_url, name, version) {
    var slash_count = ""
    var mobile_folder_name = custom_url
    if (custom_url.length < 11) {
        while (slash_count.length < 11 - custom_url.length) {
            slash_count = `${slash_count}/`
            mobile_folder_name = `${mobile_folder_name}0`
        }
    }
    mobile_folder_name = `${mobile_folder_name}0`

    const gdps_url = `https://${custom_url}.ps.fhgdps.com${slash_count}`
    const gdps_base64_url = Buffer.from(`https://${custom_url}.ps.fhgdps.com${slash_count}`).toString('base64').replaceAll("=", "")
    const boomlings_url = "http://www.boomlings.com/database"
    const boomlings_base64_url = "aHR0cDovL3d3dy5ib29tbGluZ3MuY29tL2RhdGFiYXNl"

    try {
        fs.mkdirSync(`/var/www/gdps_tools/downloads/${custom_url}`);
    } catch {}
    await exec(`cp -r /home/gdps/GDPS_Creator/Game/Mobile/Versions/${version}/GD /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}`)
    const file1 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi/libcocos2dcpp.so`, "latin1");
    const file1_modified = file1.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file1_buffer = Buffer.from(file1_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi/libcocos2dcpp.so`, file1_buffer);

    const file2 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi-v7a/libcocos2dcpp.so`, "latin1");
    const file2_modified = file2.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file2_buffer = Buffer.from(file2_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi-v7a/libcocos2dcpp.so`, file2_buffer);

    const file3 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/x86/libcocos2dcpp.so`, "latin1");
    const file3_modified = file3.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file3_buffer = Buffer.from(file3_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/x86/libcocos2dcpp.so`, file3_buffer);

    await exec(`find /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/ -type f -exec sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" {} \\;`)
    await exec(`sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/AndroidManifest.xml`)
    await exec(`sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/original/AndroidManifest.xml`)
    
    const folder54 = fs.readdirSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump`)
    for (var file_index in folder54) {
        const file_name = folder54[file_index]
        const gfile = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump/${file_name}`, "latin1");
        const gfile_modified = gfile.replaceAll("com/robtopx/geometryjump", `com/mathieu/${mobile_folder_name}`)
        const gfile_buffer = Buffer.from(gfile_modified, 'latin1')
        fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump/${file_name}`, gfile_buffer);
    }
    
    fs.renameSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump`, `/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/${mobile_folder_name}`)
    const strings_file = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/res/values/strings.xml`, "utf-8");
    const strings_file_modified = strings_file.replaceAll("Geometry Dash", name)
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/res/values/strings.xml`, strings_file_modified);

    await exec(`cd /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/ && java -jar apktool.jar b ${custom_url}`)
    await exec(`mv /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/dist/GD.apk /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK/${custom_url}.apk`)
    await exec(`cd /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK && java -jar signapk.jar certificate.pem key.pk8 ${custom_url}.apk ${custom_url}-signed.apk && mv ${custom_url}-signed.apk /var/www/gdps_tools/downloads/${custom_url}/${name}.apk`)
    await exec(`rm -rf /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}`)
    await exec(`rm /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK/${custom_url}.apk`)
}

module.exports.createPcAndroidDownload = async function (custom_url, name, version) {
    var slash_count = ""
    var mobile_folder_name = custom_url
    if (custom_url.length < 11) {
        while (slash_count.length < 11 - custom_url.length) {
            slash_count = `${slash_count}/`
            mobile_folder_name = `${mobile_folder_name}0`
        }
    }
    mobile_folder_name = `${mobile_folder_name}0`

    const gdps_url = `https://${custom_url}.ps.fhgdps.com${slash_count}`
    const gdps_base64_url = Buffer.from(`https://${custom_url}.ps.fhgdps.com${slash_count}`).toString('base64').replaceAll("=", "")
    const boomlings_url = "http://www.boomlings.com/database"
    const boomlings_base64_url = "aHR0cDovL3d3dy5ib29tbGluZ3MuY29tL2RhdGFiYXNl"

    fs.mkdirSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}`);
    fs.mkdirSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl`);
    try {
        fs.mkdirSync(`/var/www/gdps_tools/downloads/${custom_url}`);
    } catch {}
    await exec(`cp -r /home/gdps/GDPS_Creator/Game/PC/Versions/${version}/* /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl`)
    const exe_content = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl/GD.exe`, "latin1");
    const modified_exe = exe_content.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const buffer = Buffer.from(modified_exe, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl/${name}.exe`, buffer);
    await exec(`rm /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl/GD.exe`)
    await exec(`cd /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}/getdl && zip -q -r /var/www/gdps_tools/downloads/${custom_url}/${name}.zip *`)
    await exec(`rm -rf /home/gdps/GDPS_Creator/Game/PC/Working/${custom_url}`)

    await exec(`cp -r /home/gdps/GDPS_Creator/Game/Mobile/Versions/${version}/GD /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}`)
    const file1 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi/libcocos2dcpp.so`, "latin1");
    const file1_modified = file1.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file1_buffer = Buffer.from(file1_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi/libcocos2dcpp.so`, file1_buffer);

    const file2 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi-v7a/libcocos2dcpp.so`, "latin1");
    const file2_modified = file2.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file2_buffer = Buffer.from(file2_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/armeabi-v7a/libcocos2dcpp.so`, file2_buffer);

    const file3 = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/x86/libcocos2dcpp.so`, "latin1");
    const file3_modified = file3.replaceAll(boomlings_url, gdps_url).replaceAll(boomlings_base64_url, gdps_base64_url)
    const file3_buffer = Buffer.from(file3_modified, 'latin1')
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/x86/libcocos2dcpp.so`, file3_buffer);

    await exec(`find /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/lib/ -type f -exec sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" {} \\;`)
    await exec(`sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/AndroidManifest.xml`)
    await exec(`sed -i "s/com.robtopx.geometryjump/com.mathieu.${mobile_folder_name}/g" /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/original/AndroidManifest.xml`)
    
    const folder54 = fs.readdirSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump`)
    for (var file_index in folder54) {
        const file_name = folder54[file_index]
        const gfile = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump/${file_name}`, "latin1");
        const gfile_modified = gfile.replaceAll("com/robtopx/geometryjump", `com/mathieu/${mobile_folder_name}`)
        const gfile_buffer = Buffer.from(gfile_modified, 'latin1')
        fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump/${file_name}`, gfile_buffer);
    }
    
    fs.renameSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/geometryjump`, `/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/smali/com/mathieu/${mobile_folder_name}`)
    const strings_file = fs.readFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/res/values/strings.xml`, "utf-8");
    const strings_file_modified = strings_file.replaceAll("Geometry Dash", name)
    fs.writeFileSync(`/home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/res/values/strings.xml`, strings_file_modified);

    await exec(`cd /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/ && java -jar apktool.jar b ${custom_url}`)
    await exec(`mv /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}/dist/GD.apk /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK/${custom_url}.apk`)
    await exec(`cd /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK && java -jar signapk.jar certificate.pem key.pk8 ${custom_url}.apk ${custom_url}-signed.apk && mv ${custom_url}-signed.apk /var/www/gdps_tools/downloads/${custom_url}/${name}.apk`)
    await exec(`rm -rf /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/${custom_url}`)
    await exec(`rm /home/gdps/GDPS_Creator/Game/Mobile/Decompiler/SignAPK/${custom_url}.apk`)
}

module.exports.deleteGDPS = async function (custom_url, gdps_id, query) {
    await query(`DROP USER 'gdps_${custom_url}'@'localhost'`)
    await query(`DROP DATABASE gdps_${custom_url}`)
    await exec(`rm /etc/php/7.4/fpm/pool.d/${custom_url}.conf`)
    await exec(`rm /etc/nginx/sites-enabled/${custom_url}.conf`)
    await exec(`rm /home/gdps/nginx_configs/${custom_url}.conf`)
    await exec("service nginx reload")
    await exec("systemctl reload php7.4-fpm")
    await exec(`userdel -f gdps_${custom_url}`)
    await exec(`rm -rf /var/www/gdps/${custom_url}`)
    await query("delete from gdps where id = ?", [gdps_id])
    await query("delete from subusers where gdps_id = ?", [gdps_id])
}