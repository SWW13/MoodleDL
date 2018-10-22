# MoodleDL

## Requirements

* Node
* yarn

## Install
```
yarn install
```

## Usage
```
$ node index.js --help
Usage:
  index.js [OPTIONS] [ARGS]

Options:
  -d, --downloadDir [PATH]Download destination path (Default is downloads)
  -u, --moodleUrl URL    Url of moodle instance
  -t, --token STRING     Moodle access token
  -e, --exclude STRING   Exclude filenames
  -x, --excludePath STRINGExclude paths
  -m, --maxSize STRING   Maximal download size
  -s, --saveConfig BOOL  Save moodle url and access token
  -f, --forceDownload BOOLForce file download
  -k, --no-color         Omit color from output
      --debug            Show debug information
  -h, --help             Display help and usage details
```
