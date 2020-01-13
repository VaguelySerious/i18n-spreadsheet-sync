# i18n-json-csv

Sync your i18n locale files with a remote Google Sheets spreadsheet or a CSV file.

## Features

+ Sync both ways effortlessly
+ Get prompted for manual resolution when conflicts occur 
+ Force-push and force-pull functions for overriding changes
+ Google Sheets integration
+ Supports nested JSON files
+ Automatically backups local and remote files before merging

## Use

+ Export the `GOOGLE_SHEETS_API_KEY` environment variable.
+ `yarn` or `npm install`
+ Run it with `node index.js`. The usage description will be printed to the console.

## Missing Features

+ Google API sync can fail
+ Restore backups via command
+ Individual tests for all functions + coverage
+ Useful error messages for malformed json or csv
+ Resolving / merging arrays
