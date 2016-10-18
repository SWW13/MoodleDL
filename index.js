const fs = require('fs');
const cli = require('cli');
const util = require('util');
const prompt = require('prompt');
const mkdirp = require('mkdirp');
const Promise = require('promise');
const download = require('download');
const filesize = require('filesize');
const moodle_client = require('moodle-client');

const CONFIG_FILE = 'config.json';

cli.parse({
    downloadDir: ['o', 'Download destination path', 'path', 'downloads'],
    moodleUrl: ['u', 'Url of moodle instance', 'url', null],
    token: ['t', 'Moodle access token', 'string', false],
    saveConfig: ['s', 'Save moodle url and access token', 'bool', false]
});
const args = cli.options;
const DOWNLOAD_PATH = args.downloadDir;
cli.debug(JSON.stringify(args));

const getOptions = (moodleUrl, token) => new Promise((resolve, reject) => {
    const properties = {
        wwwroot: {
            message: 'Moodle URL',
            required: true
        },
        username: {
            message: 'Moodle Username',
            required: true
        },
        password: {
            message: 'Moodle Password',
            required: true,
            hidden: true
        }
    };

    if(moodleUrl) {
        delete properties.wwwroot;
    }
    if(token) {
        delete properties.username;
        delete properties.password;
    }

    prompt.start();
    prompt.get({properties}, function (err, result) {
        if (err) {
            reject(err);
        } else {
            if(token) {
                resolve({
                    wwwroot: moodleUrl || result.wwwroot,
                    token: token || result.token
                });
            } else {
                resolve({
                    wwwroot: moodleUrl || result.wwwroot,
                    username: result.username,
                    password: result.password
                });
            }
        }
    });
});
const loadConfig = () => new Promise((resolve, reject) => {
    fs.exists(CONFIG_FILE, exists => {
        if(exists) {
            fs.readFile(CONFIG_FILE, 'utf8', function (err, data) {
                if (err) {
                    cli.error(err);
                    resolve({});
                }
                else {
                    resolve(JSON.parse(data));
                }
            });
        } else {
            resolve({});
        }
    });
});
const login = () => new Promise((resolve, reject) => {
    loadConfig().then(config => {
        cli.debug(JSON.stringify(config));
        if(!args.moodleUrl) {
            args.moodleUrl = config.wwwroot;
        }
        if(!args.token) {
            args.token = config.token;
        }

        getOptions(args.moodleUrl, args.token).then(options => {
            moodle_client.init(options)
                .then(client => resolve(client))
                .catch(err => reject(err));
        });
    });
});

const moodleApiCall = (client, apiFunction, args = null, callOptions = {}) => new Promise((resolve, reject) => {
    if(args) {
        callOptions.args = args;
    }

    callOptions.wsfunction = apiFunction;
    cli.debug(JSON.stringify(callOptions));
    client.call(callOptions).then(data => {
        if(data.exception) {
            cli.debug(JSON.stringify(data));
            cli.error(data.message);
            reject(data);
        } else {
            resolve(data);
        }
    });
});

const getSiteInfo = client => moodleApiCall(client, 'core_webservice_get_site_info');
const getCourseList = (client, userId) => moodleApiCall(client, 'core_enrol_get_users_courses', { userid: userId });
const getCourseContents = (client, courseId) => moodleApiCall(client, 'core_course_get_contents', { courseid: courseId });

login().then(client => {
    cli.debug(JSON.stringify(client));

    if(args.saveConfig) {
        fs.writeFile(CONFIG_FILE, JSON.stringify({
            wwwroot: client.wwwroot,
            token: client.token
        }), err => {
            if(err) {
                cli.error(err);
            }
        });
    }

    const siteInfo = client => new Promise((resolve, reject) => {
        getSiteInfo(client).then(siteInfo => {
            cli.debug(JSON.stringify(siteInfo));
            cli.info(siteInfo.fullname + ' logged in at ' + siteInfo.sitename);
            resolve({client, userId: siteInfo.userid});
        });
    });
    const courseList = data => new Promise((resolve, reject) => {
        let {client, userId} = data;
        getCourseList(client, userId).then(courses => {
            cli.debug(JSON.stringify(courses));
            resolve({client, courses});
        });
    });
    const courseContents = data => new Promise((resolve, reject) => {
        let {client, courses} = data;
        Promise.all(courses.map(course => getCourseContents(client, course.id))).then(coursesSections => {
            let downloads = [];
            coursesSections.map((sections, courseIndex) => {
                let course = courses[courseIndex];
                sections.map(section => {
                    cli.debug(course.shortname + ' - ' + course.fullname);
                    cli.debug('  ' + section.name);

                    if (section.modules) {
                        section.modules.map(module => {
                            cli.debug('    ' + module.name + ' (' + module.modplural + ')');

                            if (module.contents) {
                                let fileNames = [];
                                module.contents.map(content => {
                                    let downloadUrl = content.fileurl + '&token=' + client.token;
                                    let filePath = (content.filePath || '/').substring(1);
                                    let path = course.shortname + '/' + section.name + '/' + module.name + '/' + filePath;
                                    let outputFile = DOWNLOAD_PATH + '/' + path + '/' + content.filename;

                                    fileNames.push('      ' + (filePath ? filePath + '/' : '') +  content.filename + ' (' + filesize(content.filesize) + ')');
                                    downloads.push({
                                        downloadUrl: downloadUrl,
                                        outputFile: outputFile,
                                        file: content
                                    });
                                });

                                fileNames.sort();
                                fileNames.map(cli.info);
                            }
                        });
                    }
                });
            });

            console.log(downloads);
            resolve(downloads);
        });
    });
    const downloadFiles = downloads => new Promise((resolve, reject) => {
        cli.info('Checking local files...');

        let fileDownloads = [];
        let downloadSize = 0;
        let downloadSizeTotal = 0;

        downloads.map((download, index) => {
            cli.progress(index / downloads.length);

            let file = download.outputFile;
            if(fs.existsSync(file)){
                let stats = fs.statSync(file);
                let mtime = new Date(util.inspect(stats.mtime));
                let mtimeTimestep = Math.round(mtime.getTime()/1000);

                if(mtimeTimestep >= download.file.timemodified) {
                    cli.debug('skipping ' + download.outputFile);
                    return;
                }

                console.log(mtime);
                console.log(download.file);

                console.log(Math.round(mtime.getTime()/1000));
                console.log(download.file.timemodified);
            }

            fileDownloads.push(download);
            downloadSizeTotal += download.file.filesize;
        });
        // TODO download
        /*download(downloadUrl).then(data => {
            mkdirp.sync(path);
            fs.writeFileSync(dst, data);
        });*/
    });

    siteInfo(client).catch(cli.error)
        .then(courseList).catch(cli.error)
        .then(courseContents).catch(cli.error)
        .then(downloadFiles).catch(cli.error);
}).catch(cli.error);