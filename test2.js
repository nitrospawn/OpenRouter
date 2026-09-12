const { Uri } = require('vscode');
console.log(Uri.joinPath(Uri.file('c:/workspace'), 'trust\\ty2.py').fsPath);
