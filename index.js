const fs = require('fs');
const cli = require('cli');
const prompt = require('prompt');
const mkdirp = require('mkdirp');
const Promise = require('promise');
const download = require('download');
const filesize = require('filesize');
const moodle_client = require('moodle-client');

cli.parse({
    downloadDir: ['d', 'Download destination path', 'path', 'downloads'],
    moodleUrl: ['u', 'Url of moodle instance', 'url', null],
    token: ['t', 'Moodle access token', 'string', false],
    saveConfig: ['s', 'Save moodle url and access token', 'string', false]
});
const args = cli.options;
cli.debug(JSON.stringify(args));

const getInput = (moodleUrl, token) => new Promise((resolve, reject) => {
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

const login = () => new Promise((resolve, reject) => {
    getInput(args.moodleUrl, args.token).then(options => {
        moodle_client.init(options)
            .then(client => resolve(client))
            .catch(err => reject(err));
    });
});

login().then(client => {
    cli.debug(JSON.stringify(client));

    // TODO saveConfig
    // TODO List
    // TODO Download
    //list_courses(client);
}).catch(cli.fatal);

function list_courses(client) {
    client.call({
        wsfunction: 'core_enrol_get_users_courses',
        args: {
            userid: 10085
        }
    }).then(function (courses) {
        //console.log(courses);

        courses.map(course => {
            //console.log(course);
            console.log(course.shortname + ' - ' + course.fullname);

            client.call({
                wsfunction: 'core_course_get_contents',
                args: {
                    courseid: course.id
                }
            }).then(function (sections) {
                //console.log(sections);

                sections.map(section => {
                    console.log('\t' + section.name);

                    if (section.modules) {
                        //console.log(section.modules);

                        section.modules.map(module => {
                            console.log('\t\t' + module.name + '(' + module.modplural + ')');
                            //console.log(module);

                            /*if(module.name === 'Laborübung 1: WireShark') {
                                console.log(module);
                            }*/

                            if (module.contents) {
                                //console.log(module.contents);

                                var files = {};
                                var filePaths = [];
                                module.contents.map(content => {
                                    filePaths.push(content.filepath);
                                    files[content.filepath] = content;
                                    //console.log('\t\t\t' + content.filename + ' (' + filesize(content.filesize) + ')' + ' => ' + content.fileurl);

                                    //console.log(content);

                                    var downloadUrl = content.fileurl + '&token=' + client.token;
                                    var path = args.downloadDir + '/' + course.shortname + '/' + section.name + '/' + module.name + '/' + (content.filepath || '/').substring(1);
                                    var dst = path + '/' + content.filename;
                                    /*download(downloadUrl).then(data => {
                                        mkdirp.sync(path);
                                        fs.writeFileSync(dst, data);
                                    });*/
                                });

                                filePaths.sort();
                                filePaths.map(filePath => {
                                  var content = files[filePath];

                                    console.log('\t\t\t' + (filePath || '/').substring(1) + content.filename + ' (' + filesize(content.filesize) + ')' + ' => ' + content.fileurl + '&token=' + client.token);
                                });
                            }
                        });
                    }
                });
            });
        });
    });
}
