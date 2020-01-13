const fs = require('fs').promises
const path = require('path')
const assert = require('assert')
const request = require('request-promise-native')
const parseCsv = require('csv-parse/lib/sync')
const writeCsv = require('csv-stringify/lib/sync')
const readline = require('readline')

const sheetsAPIBase = 'https://sheets.googleapis.com/v4/spreadsheets'
const environmentKey = "GOOGLE_SHEETS_API_KEY"
const possibleMethods = ["push", "pull", "sync"]

const args = process.argv
if (args.length < 4 || !possibleMethods.includes(args[2].toLowerCase())) {
    console.error(`Usage: ${args[1]} method local [remote] [--nofill]`)
    console.error('\tmethod: one of "push", "pull", or "sync"')
    console.error('\t\t"push" prefers local keys over remote keys')
    console.error('\t\t"pull" prefers remote keys over local keys')
    console.error('\t\t"sync" will manually ask for conflicts')
    console.error('\t\tFor any method, keys that don\'t conflict are synced to both sources')
    console.error('\ti18n-dir: a path to a folder containing i18n json files')
    console.error('\t\tMust point to a folder. Should contain "xx.json" files to be parsed, where "xx" is the iso3166 language code')
    console.error('\tspreadsheet: a file path, URL, or ID')
    console.error('\t\tLocal file paths will be parsed as CSV')
    console.error('\t\tOther strings will be interpreted as a google sheets ID')
    console.error('\t\tIf left empty, a new online sheet will be created over the google API')
    console.error('\t--no-fill')
    console.error('\t\tDisables automatically merging keys that don\'t conflict')
    console.error('\t\tUse this if you have recently deleted a lot of keys and want to remove them from the other source as well')
    return
}

const method = args[2]
const dir = args[3]
const sheet = args[4]
const nofill = args[5] === '--nofill'

async function main() {
    const local = await getLocales(dir)
    const remoteArray = await getSheet(sheet)

    // Backup files
    const backupTag = 'i18n-json-csv-backup'
    const localBackup = `/tmp/${backupTag}-local.json`
    const remoteBackup = `/tmp/${backupTag}-remote.csv`
    if (method !== 'push') {
        await fs.writeFile(localBackup, JSON.stringify(local))
        console.log('Backed up local files to', localBackup)
    }
    if (method !== 'pull') {
        await saveSheet(remoteBackup, remoteArray)
        console.log('Backed up remote file to', remoteBackup)
    }

    const remote = await arrayToLocaleJson(remoteArray)
    const merged = await mergeJson(local, remote, {method, fill: !nofill})
    const mergedArray = await localeJsonToArray(merged)
    if (method !== 'pull') {
        await saveSheet(sheet, mergedArray)
    }
    if (method !== 'push') {
        await saveLocales(dir, merged)
    }
    console.log('Done.')
}

async function getLocales(directory) {
    console.info('Getting local i18n data...')
    const dircontents = await fs.readdir(directory)
    const validpaths = dircontents.filter(f => /[a-z]{2}\.json/.test(f))

    const ret = {}
    const files = await Promise.all(validpaths.map(vp => fs.readFile(path.join(dir, vp), { encoding: 'utf8'})))

    for (let i = 0; i < files.length; i++) {
        const locale = validpaths[i].slice(0, 2)
        ret[locale] = JSON.parse(files[i])
    }
    return ret
}

async function saveLocales(directory, locales) {
    console.info('Saving local files...')
    for (let lang in locales) {
        const filePath = path.join(directory, lang + '.json')
        await fs.writeFile(filePath, JSON.stringify(locales[lang], null, 2))
        console.info('Writing', filePath)
    }
}

function getApiKeyOrCrash() {
    if (!process.env[environmentKey]) {
        console.error(`This function requires ${environmentKey} to be set`)
        process.exit()
    }
    return process.env[environmentKey]
}

function isValidCSVPath(path) {
    if (path.endsWith('.csv')) {
        return true
    }
    return false
}

async function getSheet(pathOrID) {
    console.info(`Getting spreadsheet "${pathOrID}"...`)
    if (isValidCSVPath(pathOrID)) {
        console.info('Parsing csv file...')
        let file
        try {
            file = await fs.readFile(pathOrID, { encoding: 'utf8' })
        } catch (e) {
            console.log('Could not find csv file. Creating new one.')
            file = []
        }
        return parseCsv(file)
    }

    const key = getApiKeyOrCrash()

    if (!pathOrID) {
        return []
    }

    const sheetURL = `${sheetsAPIBase}/${pathOrID}/values/A1:X100000?key=${key}`
    const ret = await request(sheetURL, { json: true }).catch(() => null)
    if (!ret || !ret.values) {
        // console.log('Could not get sheet')
        // TODO Create new spreadsheet
        const createSheetURL = `${sheetsAPIBase}?key=${key}`
        console.log(createSheetURL)
        const ret = await request({
            method: 'POST',
            uri: createSheetURL,
            json: true
        })
        console.log(ret)
    }
    // return ret.values
    return []
}

async function saveSheet(path, array) {
    console.info('Saving spreadsheet...')
    if (isValidCSVPath(path)) {
        console.info('Writing csv to:', path)
        const content = writeCsv(array)
        await fs.writeFile(path, content, { encoding: 'utf8' })
        return
    }
    
    const key = getApiKeyOrCrash()

    if (!pathOrID) {
        // Create sheet
        // Save sheet
        return
    }

    const newSheetURL = `https://docs.google.com/spreadsheets/d/${newID}/edit`
    console.log('Sheet pushed to:', newSheetURL)
}

function arrayToLocaleJson(array) {
    console.info('Formatting spreadsheet...')
    if (array.length === 0) {
        return {}
    }
    const langs = array[0].slice(1)
    const rows = array.slice(1)

    const ret = {}
    for (let lang of langs) {
        ret[lang] = {}
    }

    for (let row of rows) {
        const keys = row[0].split('.')
        for (let lang of langs) {
            let prev = null
            let parent = ret[lang]
            for (let key of keys) {
                if (!parent[key]) {
                    parent[key] = {}
                } 
                prev = parent
                parent = parent[key]
            }
            prev[keys[keys.length - 1]] = row[langs.indexOf(lang) + 1]
        }
    }
    return ret
}

async function mergeJson(a, b, {fill=true, method="sync"}) {
    console.info('Merging sources...')

    // "a" ends up being the merged object
    async function deepMerge(a, b, hist) {

        const keys = [...new Set(Object.keys(a).concat(Object.keys(b)))]
        for (let key of keys) {

            hist.push(key)
            const ID = hist.join('.')
            const aType = typeof a[key]
            const bType = typeof b[key]
            if (bType === 'undefined' || b[key] === '') {
                // TODO These cases need to be adjusted for methods
                // TODO Use the fill parameter
                // console.log(`Keeping: ${ID}`)
            } else if ((a[key] === '' || aType === 'undefined') && bType !== 'undefined') {
                console.info(`Adding to locales: ${ID} = ${JSON.stringify(b[key])}`)
                a[key] = b[key]
            } else if ((aType === 'string' || Array.isArray(a[key])) && (bType === 'string' || Array.isArray(b[key])) && a[key] !== b[key]) {
                switch (method) {
                    case "push":
                        console.info(`Replacing remote "${b[key]}" with local "${a[key]}" at ${ID}`)
                        break;
                    case "pull":
                        console.info(`Replacing local "${a[key]}" with remote "${b[key]}" at ${ID}`)
                        a[key] = b[key]
                        break;
                    case "sync":
                        const query = `Please choose local "${a[key]}" or remote "${b[key]}" at ${ID}:`
                        const answer = await getInput(query)
                        if (['l', 'local', '1', 'first', 'A'].includes(answer.toLowerCase())) {
                            console.info(`Using local locale "${b[key]}" at ${ID}`)
                        } else {
                            console.info(`Using remote locale "${b[key]}" at ${ID}`)
                            a[key] = b[key]
                        }
                        break;
                }
            // } else if (Array.isArray(aType) && !Array.isArray(bType)) {
            //     console.log(`Replacing non-array in sheet with array at ${ID}`)
            //     b[key] = a[key]
            // } else if (Array.isArray(bType) && !Array.isArray(aType)) {
            //     console.log(`Replacing non-array in locales with array at ${ID}`)
            //     a[key] = b[key]
            } else if (aType === 'object' && bType === 'object') {
                await deepMerge(a[key], b[key], hist)
            }
            hist.pop()
        }
        return a
    }

    const ret = await deepMerge(a, b, [])
    return ret
}

function localeJsonToArray(json) {
    console.info('Converting locales to array')
    const langs = Object.keys(json)

    function recursiveStringify(obj, res, hist) {
        for (let i in obj) {
            hist.push(i)
            if (typeof obj[i] === 'string' || Array.isArray(obj[i])) {
                const ID = hist.join('.')
                res[ID] = obj[i]
            } else if (typeof obj[i] === 'object') {
                recursiveStringify(obj[i], res, hist)
            }
            hist.pop()
        }
        return res
    }

    const ret = []
    const keys = {}
    for (let lang of langs) {
        const res = recursiveStringify(json[lang], {}, [])
        for (let key in res) {
            if (!keys[key]) {
                keys[key] = {}
            }
            keys[key][lang] = res[key]
        }
    }

    for (let key in keys) {
        ret.push([key, ...langs.map(l => keys[key][l] || '')])
    }

    ret.unshift(['key', ...langs])
    return ret
}

// https://stackoverflow.com/questions/18193953/waiting-for-user-to-enter-input-in-node-js
function getInput(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }))
}

if (require.main === module) {
    main()
}

module.exports = {
    localeJsonToArray,
    arrayToLocaleJson,
    saveSheet,
    getSheet,
    mergeJson,
    getLocales,
    saveLocales,
}