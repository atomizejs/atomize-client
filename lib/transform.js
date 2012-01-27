/*global process, require */
/*jslint devel: true */

var walker = require('./walker');
var fs = require('fs');
var input = process.argv[2];
var output = process.argv[3];

var dataReady = function (err, data) {
    var ast, pi, pp, result;
    if (err) {
        throw err;
    }
    ast = walker.parse(data);
    pi = new walker.ProxyInjector(ast);
    pi.transform();
    pp = new walker.PrettyPrinter(pi.ast);
    result = pp.print();
    fs.writeFileSync(output, result, 'utf8');
};

fs.readFile(input, 'utf8', dataReady);
