var prompt = require('prompt');
var moodle_client = require('moodle-client');
var filesize = require('filesize');

var schema = {
    properties: {
        wwwroot: {
            default: 'https://moodle.htwg-konstanz.de/moodle/'
        },
        username: {
            default: 'siwoerne',
            required: true
        },
        password: {
            required: true,
            hidden: true
        }
    }
};

prompt.start();
prompt.get(schema, function (err, result) {
    moodle_client.init({
        wwwroot: result.wwwroot,
        username: result.username,
        password: result.password

    }).then(function (client) {
        //get_userid(client);
        list_courses(client);
    }).catch(function (err) {
        console.log('Unable to initialize the client: ' + err);
    });
});

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

                            /*if(module.name === 'Protokollablage') {
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
                                });

                                filePaths.sort();
                                filePaths.map(filePath => {
                                  var content = files[filePath];
                                  if(!filePath) {
                                    filePath = '/';
                                  }
                                  
                                  console.log('\t\t\t' + filePath.substring(1) + content.filename + ' (' + filesize(content.filesize) + ')' + ' => ' + content.fileurl);
                                });
                            }
                        });
                    }
                });
            });
        });
    });
}
