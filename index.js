const fs = require('fs');
const cli = require('cli');
const prompt = require('prompt');
const mkdirp = require('mkdirp');
const download = require('download');
const filesize = require('filesize');
const moodle_client = require('moodle-client');

cli.parse({
    downloadDir: ['d', 'Download destination path', 'path', 'downloads'],
    moodleUrl: ['u', 'Url of moodle instance', 'url', null],
    token: ['t', 'Moodle access token', 'string', false],
    getToken: [false, 'Acquire moodle access token', 'string', false]
});

console.log(cli.options);
//cli.exit(0);

const args = cli.options;
if(!args.moodleUrl || !args.token) {
    var properties = {};

    if(!args.moodleUrl) {
        properties.moodleUrl = {
            required: true
        };
    }
    if(!args.token) {
        properties.username = {
            required: true
        };
        properties.password = {
            required: true,
                hidden: true
        };
    }

    prompt.start();
    prompt.get({properties}, function (err, result) {
        let options = {
            wwwroot: args.moodleUrl || result.moodleUrl,
        };

        if(args.token) {
            options.token = args.token;
        } else {
            options.username = result.username;
            options.password = result.password;
        }

        connect(options);
    });
} else {
    connect({
        wwwroot: args.moodleUrl,
        token: args.token
    });
}

function connect(options) {
    moodle_client.init(options)
    .then(function (client) {
        console.log(client);

        if(args.getToken) {
            cli.exit(0);
        }

        //get_userid(client);
        //list_courses(client);
    }).catch(function (err) {
        console.log('Unable to initialize the client: ' + err);
    });
}

/*prompt.start();
prompt.get(schema, function (err, result) {
    moodle_client.init({
        wwwroot: result.wwwroot,
        username: result.username,
        password: result.password

    }).then(function (client) {
        console.log(client);
        //get_userid(client);
        list_courses(client);
    }).catch(function (err) {
        console.log('Unable to initialize the client: ' + err);
    });
});*/

function get_userid(client) {
    client.call({
        //wsfunction: 'core_user_view_user_profile',
        wsfunction: 'core_user_get_user_preferences',
        args: {
            name: 'id',
            userid: 0
        }
    }).then(function (data) {
        console.log(data);
    });
}
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
                                    var path = downloadDir + '/' + course.shortname + '/' + section.name + '/' + module.name + '/' + (content.filepath || '/').substring(1);
                                    var dst = path + '/' + content.filename;
                                    download(downloadUrl).then(data => {
                                        mkdirp.sync(path);
                                        fs.writeFileSync(dst, data);
                                    });
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
