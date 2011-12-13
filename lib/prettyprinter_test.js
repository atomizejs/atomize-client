/*global exports, require */
/*jslint devel: true */

/*
 * Tests for the pretty printer.
 */

var walker = require('./walker');

exports.testASTIdempotency = function (test) {
    // This test ensures that the AST that we get before and after
    // going through the pretty printer is the same (deepEquals).

    var i, keys, ast1, ast2;
    keys = Object.keys(walker.PrettyPrinter.prototype);

    for (i = 0; i < keys.length; i += 1) {
        if (Function === walker.PrettyPrinter.prototype[keys[i]].constructor) {
            ast1 = walker.parse(walker.PrettyPrinter.prototype[keys[i]].toString());
            ast2 = walker.parse(new walker.PrettyPrinter(ast1).print());
            test.deepEqual(ast1, ast2, "PrettyPrinter.prototype." + keys[i] + " not idempotent.");
        }
    }

    test.done();
};
