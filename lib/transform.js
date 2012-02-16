/*global process, require */
/*jslint devel: true */

var walker = require('./walker');
var fs = require('fs');
var input = process.argv[2];
var output = process.argv[3];
var atomize = process.argv[4];
var ignore = process.argv.slice(5);

var dataReady = function (err, data) {
    var ast, pi, pp, result;
    if (err) {
        throw err;
    }
    try {
        ast = walker.parse(data);
        pi = new walker.ProxyInjector(ast, atomize, ignore);
        pi.transform();
        pp = new walker.PrettyPrinter(pi.ast);
        result = pp.print();
        fs.writeFileSync(output, result, 'utf8');
    } catch (err) {
        console.log(err.name + ":\n" + err.message + " at " + err.line + "," + err.column);
    }
};

fs.readFile(input, 'utf8', dataReady);
