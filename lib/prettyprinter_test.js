/*global exports, require */
/*jslint devel: true */

/*
 * Tests for the pretty printer.
 */

var walker = require('./walker');

exports.testASTIdempotency = function (test) {
    // This test ensures that the AST that we get before and after
    // going through the pretty printer is the same (deepEquals).

    var i, keys, ast1, ast2, ast3, str, fun;
    keys = Object.keys(walker.PrettyPrinter.prototype);

    for (i = 0; i < keys.length; i += 1) {
        if (Function === walker.PrettyPrinter.prototype[keys[i]].constructor) {
            ast1 = walker.parse(walker.PrettyPrinter.prototype[keys[i]].toString());
            str = new walker.PrettyPrinter(ast1).print();
            ast2 = walker.parse(str);
            test.deepEqual(ast1, ast2, "Reformatting PrettyPrinter.prototype." + keys[i] + " is not idempotent.");

            fun = eval("(" + str + ")");
            ast3 = walker.parse(fun.toString());
            test.deepEqual(ast1, ast3, "Parsing the eval'd reformatted PrettyPrinter.prototype." + keys[i] + " is not idempotent.\n" + str);
        }
    }

    test.done();
};
