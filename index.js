const fs = require('fs');
const cli = require('cli');
const path = require('path');
const util = require('util');
const got = require('got');
const prompt = require('prompt');
const mkdirp = require('mkdirp');
const Promise = require('promise');
const bytes = require('bytes');
const sanitize = require("sanitize-filename");
const moodle_client = require('moodle-client');
const promiseConcurrency = require('promise-concurrency');

const CONFIG_FILE = 'config.json';
const CONCURRENT_DOWNLOAD_LIMIT = 3;
const DOWNLOAD_TIMEOUT = 30000;

cli.enable('status');
cli.parse({
    downloadDir: ['d', 'Download destination path', 'path', 'downloads'],
    moodleUrl: ['u', 'Url of moodle instance', 'url', null],
    token: ['t', 'Moodle access token', 'string', false],
    exclude: ['e', 'Exclude filenames', 'string', null],
    excludePath: ['x', 'Exclude paths', 'string', null],
    maxSize: ['m', 'Maximal download size', 'string', false],
    saveConfig: ['s', 'Save moodle url and access token', 'bool', false],
    forceDownload: ['f', 'Force file download', 'bool', false]
});
const args = cli.options;
const DOWNLOAD_PATH = args.downloadDir;
const exclude_regex = args.exclude != null ? RegExp(args.exclude) : null;
const exclude_path_regex = args.excludePath != null ? RegExp(args.excludePath) : null;
cli.debug(JSON.stringify(args));

const joinPath = (base, dirs) => {
    let fullPath = base;

    for (let dir of dirs) {
        if(dir) {
            fullPath = path.join(fullPath, sanitize(dir));
        }
    }

    return fullPath;
};

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
const saveConfig = data => new Promise((resolve, reject) => {
    fs.writeFile(CONFIG_FILE, JSON.stringify(data), err => {
        if(err) {
            cli.error(err);
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
const moodleIdsToArgs = (key, ids = [], args = {}) => {
    ids.map((id, i) => { args[key + '[' + i + ']'] = id });
    return args;
};

const moodleSiteInfo = client => moodleApiCall(client, 'core_webservice_get_site_info');
const moodleCourseList = (client, userId) => moodleApiCall(client, 'core_enrol_get_users_courses', { userid: userId });
const moodleCourseContents = (client, courseId) => moodleApiCall(client, 'core_course_get_contents', { courseid: courseId });
const moodleCourseForums = (client, courseIds) => moodleApiCall(client, 'mod_forum_get_forums_by_courses', moodleIdsToArgs('courseids', courseIds));
const moodleForumDiscussions = (client, forumId) => moodleApiCall(client, 'mod_forum_get_forum_discussions_paginated', { forumid: forumId, page: 0, perpage: 2147483647 });
const moodleForumDiscussionPosts = (client, discussionId) => moodleApiCall(client, 'mod_forum_get_forum_discussion_posts', { discussionid: discussionId });
const moodleCourseAssignments = (client, courseIds) => moodleApiCall(client, 'mod_assign_get_assignments', moodleIdsToArgs('courseids', courseIds));

const siteInfo = client => new Promise((resolve, reject) => {
    moodleSiteInfo(client).then(siteInfo => {
        cli.debug(JSON.stringify(siteInfo));
        cli.ok(siteInfo.fullname + ' logged in at ' + siteInfo.sitename + '.');
        resolve({client, userId: siteInfo.userid});
    });
});
const courseList = data => new Promise((resolve, reject) => {
    let {client, userId} = data;
    moodleCourseList(client, userId).then(courses => {
        cli.debug(JSON.stringify(courses));
        cli.ok('Found ' + courses.length + ' courses.');
        resolve({client, courses});
    });
});
const courseContents = data => new Promise((resolve, reject) => {
    let {client, courses} = data;
    Promise.all(courses.map(course => moodleCourseContents(client, course.id))).then(coursesSections => {
        let downloads = [];
        coursesSections.map((sections, courseIndex) => {
            let course = courses[courseIndex];
            sections.map(section => {
                cli.debug(course.shortname + ' - ' + course.fullname);
                cli.debug('  ' + section.name);

                if (section.modules) {
                    section.modules.map(module => {
                        cli.debug('    ' + module.name + ' (' + module.modname + ')');

                        if (module.contents) {
                            let fileNames = [];
                            module.contents.map(content => {
                                if(module.modname === 'url') {
                                    content.filename += '.url';
                                }

                                let downloadUrl = content.fileurl + '&token=' + client.token;
                                let filePath = (content.filepath || '/').substring(1);
                                let outputPath = joinPath(DOWNLOAD_PATH, [course.shortname, section.name, (['resource', 'url'].indexOf(module.modname) === -1 ? (sanitize(module.name) + '/') : undefined), filePath]);
                                let outputFile = sanitize(content.filename);

                                fileNames.push('      ' + (filePath ? filePath : '') +  content.filename + ' (' + bytes(content.filesize) + ')');
                                downloads.push({
                                    url: downloadUrl,
                                    outputPath: outputPath,
                                    outputFile: outputFile,
                                    file: content,
                                    type: module.modname
                                });
                            });

                            fileNames.sort();
                            fileNames.map(cli.debug);
                        }
                    });
                }
            });
        });

        cli.ok('Found ' + downloads.length + ' files in courses.');
        resolve({client, courses, downloads});
    });
});
const courseForumDiscussions = data => new Promise((resolve, reject) => {
    let {client, courses, downloads} = data;

    moodleCourseForums(client, courses.map(course => course.id)).then(forums => {
        Promise.all(forums.map(forum => moodleForumDiscussions(client, forum.id))).then(forumDiscussions => {
            let discussionList = [];
            forumDiscussions.map((data, i) => {
                let forum = forums[i];
                let discussions = data.discussions;

                discussions = discussions.map(discussion => {
                    discussion.course = courses.find(course => course.id == forum.course);
                    discussion.forum = forum;
                    return discussion;
                });

                discussionList = discussionList.concat(discussions);
            });

            cli.ok('Found ' + discussionList.length + ' forums in courses.');
            resolve({client, courses, discussions: discussionList, downloads});
        });
    });
});
const forumDiscussionPosts = data => new Promise((resolve, reject) => {
    let {client, courses, discussions, downloads} = data;
    let downloadsCountOld = downloads.length;

    Promise.all(discussions.map(discussion => moodleForumDiscussionPosts(client, discussion.discussion))).then(discussionsPosts => {
        discussionsPosts.map((data, i) => {
            let discussion = discussions[i];
            let course = discussion.course;
            let forum = discussion.forum;
            let posts = data.posts;

            cli.debug(course.shortname + ' - ' + course.fullname);
            cli.debug('  ' + forum.name);
            cli.debug('    ' + discussion.name);

            posts.map(post => {
                if (post.attachments) {
                    let fileNames = [];
                    post.attachments.map(attachment => {
                        let downloadUrl = attachment.fileurl + '?token=' + client.token;
                        let outputPath = joinPath(DOWNLOAD_PATH, [course.shortname, forum.name, discussion.name]);
                        let outputFile = sanitize(attachment.filename);

                        fileNames.push('      ' + attachment.filename);
                        downloads.push({
                            url: downloadUrl,
                            outputPath: outputPath,
                            outputFile: outputFile,
                            file: attachment
                        });
                    });

                    fileNames.sort();
                    fileNames.map(cli.debug);
                }
            });
        });

        cli.ok('Found ' + (downloads.length - downloadsCountOld) + ' files in forum attachments.');
        resolve({client, courses, downloads});
    });
});
const courseAssignments = data => new Promise((resolve, reject) => {
    let {client, courses, downloads} = data;
    let downloadsCountOld = downloads.length;
    moodleCourseAssignments(client, courses.map(course => course.id)).then(data => {
        let courses = data.courses;
        courses.map(course => {
            course.assignments.map(assignment => {
                cli.debug(course.shortname + ' - ' + course.fullname);
                cli.debug('  ' + assignment.name);

                if (assignment.introattachments) {
                    let fileNames = [];
                    assignment.introattachments.map(content => {
                        let downloadUrl = content.fileurl + '?token=' + client.token;
                        let outputPath = joinPath(DOWNLOAD_PATH, [course.shortname, assignment.name]);
                        let outputFile = sanitize(content.filename);

                        fileNames.push('      ' + content.filename);
                        downloads.push({
                            url: downloadUrl,
                            outputPath: outputPath,
                            outputFile: outputFile,
                            file: content
                        });
                    });

                    fileNames.sort();
                    fileNames.map(cli.debug);
                }
            });
        });

        cli.ok('Found ' + (downloads.length - downloadsCountOld) + ' files in course assignments.');
        resolve(downloads);
    });
});
const downloadFiles = downloads => new Promise((resolve, reject) => {
    let fileDownloads = [];
    let urlDownloads = 0;
    let unkownFilesizeDownloads = 0;
    let downloadSize = 0;
    let downloadSizeTotal = 0;

    downloads.map(dl => {
        if(fs.existsSync(dl.outputFile) && !args.forceDownload){
            let stats = fs.statSync(dl.outputFile);
            let mtime = new Date(util.inspect(stats.mtime));
            let mtimeTimestep = Math.round(mtime.getTime()/1000);
            let skipp = mtimeTimestep >= dl.file.timemodified && stats.size === dl.file.filesize;

            cli.debug(dl.outputFile +
                '\n\ttimestamp:\tlocale = ' + mtimeTimestep + '\tmoodle = ' + (dl.file.timemodified ? dl.file.timemodified : 'unknown') +
                '\n\tsize:\t\tlocale = ' + bytes(stats.size) + '\tmoodle = ' + (dl.file.filesize ? bytes(dl.file.filesize) : 'unknown') +
                (skipp ? '\n\t=> skipping' : '\n\t=> redownload'));

            if(skipp) {
                return;
            }
        }

        if(exclude_regex != null && exclude_regex.test(dl.outputFile)) {
            cli.info(dl.outputFile + ' - skipped: matched exclude regex ' + exclude_regex);
            return;
        }
        if(exclude_path_regex != null && exclude_path_regex.test(dl.outputPath)) {
            cli.info(dl.outputFile + ' - skipped: path ' + dl.outputPath + ' matched exclude path regex ' + exclude_path_regex);
            return;
        }

        if(dl.file.filesize) {
            if(args.maxSize && dl.file.filesize > bytes(args.maxSize)) {
                cli.info(dl.outputFile + ' - skipped: ' + bytes(dl.file.filesize) + ' bigger than max download size ' + bytes(bytes(args.maxSize)));
                return;
            }

            downloadSizeTotal += dl.file.filesize;
        } else {
            switch (dl.type) {
                case 'url':
                    urlDownloads++;
                    break;
                default:
                    unkownFilesizeDownloads++;
                    break;
            }
        }

        fileDownloads.push(dl);
    });

    if(unkownFilesizeDownloads > 0) {
        cli.info('Could not determine file size of ' + unkownFilesizeDownloads + ' file(s). Force redownload.')
    }
    if(urlDownloads > 0) {
        cli.info('Downloads contain ' + urlDownloads + ' url(s). Force recreate.')
    }

    if(fileDownloads.length > 0) {
        cli.ok('Found ' + fileDownloads.length + ' new or changed files.');
        cli.progress(0);

        const donwloadPromises = fileDownloads.map(dl => {
            return () => new Promise((resolve, reject) => {
                mkdirp.sync(dl.outputPath);
                const output = joinPath(dl.outputPath, [dl.outputFile]);
                const writeFile = data => {
                    fs.writeFileSync(output, data);
                    cli.ok(dl.outputFile);

                    if(dl.file.filesize) {
                        if(data.length == dl.file.filesize) {
                            downloadSize += dl.file.filesize;
                            ok(data.length);
                            updateProgress();
                        } else {
                            cli.error(`{dl.outputFile}: size differ\n\t local: ${data.length}\t remote: ${dl.file.filesize}`);
                        }
                    }
                };
                const ok = (length) => {
                    if(dl.file.filesize) {
                        if(length == dl.file.filesize) {
                            downloadSize += dl.file.filesize;
                        } else {
                            cli.error(`${dl.outputFile}: size differ\n\t local: ${length}\t remote: ${dl.file.filesize}`);
                        }
                    }

                    cli.ok(output.substring(DOWNLOAD_PATH.length + 1));
                    resolve();
                };
                const updateProgress = () => cli.progress(downloadSize / downloadSizeTotal);

                cli.debug(dl.url);
                switch (dl.type) {
                    case 'url':
                        writeFile(`[InternetShortcut]\nURL=${dl.url}\n`);
                        ok();
                        break;
                    default:
                        let transferred = 0;
                        got.stream(dl.url, { timeout: DOWNLOAD_TIMEOUT })
                        .on('downloadProgress', progress => {
                            downloadSize += progress.transferred - transferred;
                            transferred = progress.transferred;
                            updateProgress();
                        })
                        .on('error', (error) => {
                            cli.debug(JSON.stringify(error));
                            cli.error(`${error.statusCode} ${error.statusMessage} - ${error.method} ${error.url}`);
                        })
                        .pipe(fs.createWriteStream(output))
                        .on('end', () => { ok(transferred); resolve('end') })
                        .on('finish', () => { ok(transferred); resolve('finish') })
                        .on('error', reject);
                        break;
                }
            });
        });
        promiseConcurrency(donwloadPromises, CONCURRENT_DOWNLOAD_LIMIT);
    } else {
        cli.info('All files are up to date.');
    }
});

login().then(client => {
    cli.debug(JSON.stringify(client));

    if(args.saveConfig) {
        saveConfig({
            wwwroot: client.wwwroot,
            token: client.token
        });
    }

    siteInfo(client).catch(cli.error)
        .then(courseList).catch(cli.error)
        .then(courseContents).catch(cli.error)
        .then(courseForumDiscussions).catch(cli.error)
        .then(forumDiscussionPosts).catch(cli.error)
        .then(courseAssignments).catch(cli.error)
        .then(downloadFiles).catch(cli.error);
}).catch(cli.error);
