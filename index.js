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

cli.enable('status');
cli.parse({
    downloadDir: ['d', 'Download destination path', 'path', 'downloads'],
    moodleUrl: ['u', 'Url of moodle instance', 'url', null],
    token: ['t', 'Moodle access token', 'string', false],
    saveConfig: ['s', 'Save moodle url and access token', 'bool', false],
    forceDownload: ['f', 'Force file download', 'bool', false]
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
            cli.ok(siteInfo.fullname + ' logged in at ' + siteInfo.sitename + '.');
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
                                    let path = DOWNLOAD_PATH + '/' + course.shortname + '/' + section.name + '/' + module.name + '/' + filePath;
                                    let outputFile = path + '/' + content.filename;

                                    fileNames.push('      ' + (filePath ? filePath + '/' : '') +  content.filename + ' (' + filesize(content.filesize) + ')');
                                    downloads.push({
                                        url: downloadUrl,
                                        outputPath: path,
                                        outputFile: outputFile,
                                        file: content
                                    });
                                });

                                fileNames.sort();
                                fileNames.map(cli.debug);
                            }
                        });
                    }
                });
            });

            cli.ok('Found ' + downloads.length + ' files in moodle.');
            resolve(downloads);
        });
    });
    const downloadFiles = downloads => new Promise((resolve, reject) => {
        let fileDownloads = [];
        let unkownFilesizeDownloads = 0;
        let downloadSize = 0;
        let downloadSizeTotal = 0;

        downloads.map(dl => {
            if(dl.file.filesize === 0) {
                unkownFilesizeDownloads++;
            }
            if(fs.existsSync(dl.outputFile) && !args.forceDownload){
                let stats = fs.statSync(dl.outputFile);
                let mtime = new Date(util.inspect(stats.mtime));
                let mtimeTimestep = Math.round(mtime.getTime()/1000);
                let skipp = mtimeTimestep >= dl.file.timemodified && stats.size === dl.file.filesize;

                cli.debug(dl.outputFile +
                    '\n\ttimestamp:\tlocale = ' + mtimeTimestep + '\tmoodle = ' + dl.file.timemodified +
                    '\n\tsize:\t\tlocale = ' + filesize(stats.size) + '\tmoodle = ' + filesize(dl.file.filesize) +
                    (skipp ? '\n\t=> skipping' : ''));

                if(skipp) {
                    return;
                }
            }

            fileDownloads.push(dl);
            downloadSizeTotal += dl.file.filesize;
        });

        if(unkownFilesizeDownloads > 0) {
            cli.info('Could not demeter file size of ' + unkownFilesizeDownloads + ' file(s). Force redownload.')
        }
        if(fileDownloads.length > 0) {
            cli.ok('Found ' + fileDownloads.length + ' new or changed files.');
            cli.progress(0);
            fileDownloads.map(dl => {
                download(dl.url).then(data => {
                    mkdirp.sync(dl.outputPath);
                    fs.writeFileSync(dl.outputFile, data);

                    downloadSize += dl.file.filesize;
                    cli.progress(downloadSize / downloadSizeTotal);
                });
            });
        } else {
            cli.info('All files are up to date.');
        }
    });

    siteInfo(client).catch(cli.error)
        .then(courseList).catch(cli.error)
        .then(courseContents).catch(cli.error)
        .then(downloadFiles).catch(cli.error);
}).catch(cli.error);