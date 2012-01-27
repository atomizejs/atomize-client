/*global exports, require */
/*jslint devel: true */

(function () {
    'use strict';

    var parser = require('./javascript_parser');


    // In general keep in mind that the stack-based nature of this
    // visitor is reverse-polish-notation form. I.e. in a sequence of
    // calls to walk or invoke, they'll actually get visited in LIFO
    // order.

    function TreeWalker(ast, recv) {
        var self = this;
        this.ast = ast;
        this.recv = recv;
        this.stack =
            [{traverse: ast, parent: undefined, name: undefined},
             {fun: function () {
                 if (self.hasProp(self.recv, 'finished') &&
                     Function === self.recv.finished.constructor) {
                     return self.recv.finished();
                 }
             }}];
        this.current = undefined;
    }

    TreeWalker.prototype = {
        hasOwnProp: function (obj, prop) {
            return ({}).hasOwnProperty.call(obj, prop);
        },

        hasProp: function (obj, prop) {
            return undefined !== obj[prop];
        },

        isPrimitive: function (obj) {
            return obj !== Object(obj);
        },

        traverse: function () {
            var item, parent, obj, name, keys, i, key;
            while (0 !== this.stack.length) {
                item = this.stack.shift();

                if (this.hasOwnProp(item, 'traverse')) {
                    obj = item.traverse;
                    parent = item.parent;
                    name = item.name;
                    this.current = obj;
                    if (this.hasOwnProp(obj, 'type')) {
                        if (this.hasProp(this.recv, obj.type) &&
                            Function === this.recv[obj.type].constructor) {
                            this.recv[obj.type](this, parent, obj, name);
                        } else {
                            keys = Object.keys(obj);
                            for (i = keys.length - 1; i >= 0; i -= 1) {
                                key = keys[i];
                                if (!this.isPrimitive(obj[key])) {
                                    this.stack.unshift({traverse: obj[key], parent: obj, name: key});
                                }
                            }
                        }
                    } else {
                        if (Array === obj.constructor) {
                            for (i = obj.length - 1; i >= 0; i -= 1) {
                                this.stack.unshift({traverse: obj[i], parent: obj, name: i});
                            }
                        } else {
                            if (this.hasProp(this.recv, 'unknown') &&
                                Function === this.recv.unknown.constructor) {
                                this.recv.unknown(this, parent, obj);
                            }
                        }
                    }
                } else if (this.hasOwnProp(item, 'fun')) {
                    this.current = item.current;
                    item.fun(this, item.current);
                }
            }
        },

        walk: function (obj, key) {
            if (undefined === key) {
                // the obj is in fact the name
                this.stack.unshift({traverse: this.current[obj], parent: this.current, name: obj});
            } else {
                this.stack.unshift({traverse: obj[key], parent: obj, name: key});
            }
        },

        invoke: function (fun) {
            this.stack.unshift({fun: fun, current: this.current});
        }
    };


    function PrettyPrinter(ast) {
        this.ast = ast;
        this.treeWalker = new TreeWalker(ast, this);
        this.indentation = 0;
        this.needsTermination = true;
    }

    PrettyPrinter.prototype = {

        indentUnit: '    ',

        print: function () {
            this.text = [];
            this.whiteSpaceOnly = true;
            this.lines = [];
            this.linesState = [];
            this.treeWalker.traverse();
            return this.toString();
        },

        toString: function () {
            return this.lines.join("\n") + this.text.join("");
        },

        append: function (str) {
            this.whiteSpaceOnly = false;
            this.text.push(str);
        },

        incDepth: function () {
            this.indentation += 1;
        },

        decDepth: function () {
            this.indentation -= 1;
        },

        freshScope: function () {
            this.lines.push(this.text);
            this.linesState.push(this.whiteSpaceOnly);
            this.text = [];
            this.whiteSpaceOnly = true;
            this.needsTermination = true;
        },

        popScope: function () {
            this.text = this.lines.pop();
            this.whiteSpaceOnly = this.linesState.pop();
        },

        popAndFreshScope: function () {
            this.popScope();
            this.freshScope();
        },

        indent: function () {
            var i;
            for (i = 0; i < this.indentation; i += 1) {
                this.text.push(this.indentUnit);
            }
        },

        terminate: function () {
            if (this.needsTermination) {
                this.append(";");
            }
        },

        withFreshScopeJoin: function (fun) {
            this.freshScope();
            fun();
            var text = this.text.join("");
            this.popScope();
            this.append(text);
        },

        formatStatements: function (tw, statements, obj) {
            var i, self = this;
            for (i = obj.length - 1; i >= 0; i -= 1) {
                tw.invoke(function () {
                    if (self.whiteSpaceOnly) {
                        statements.push("\n");
                    } else {
                        self.terminate();
                        statements.push(self.text.join("") + "\n");
                    }
                    self.popScope();
                });
                tw.walk(obj, i);
                tw.invoke(function () {
                    self.freshScope();
                    self.indent();
                });
            }
        },

        forWhileLoop: function (tw, elements, obj, init) {
            var i, self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.withFreshScopeJoin(function () {
                    self.append(init(elements));
                    if ("Block" === obj.statement.type) {
                        self.append(" ");
                        self.needsTermination = false;
                    } else {
                        self.append("\n");
                        self.incDepth();
                        self.indent();
                        self.decDepth();
                    }
                    self.append(body);
                });
            });
            tw.walk('statement');
            for (i = 0; i < elements.length; i += 1) {
                (function () {
                    var j = i;
                    if (obj[elements[j]]) {
                        tw.invoke(function () {
                            elements[elements[j]] = self.text.join("");
                            self.popAndFreshScope();
                        });
                        tw.walk(elements[j]);
                    } else {
                        elements[elements[j]] = '';
                    }
                }());
            }
            this.freshScope();
        },

        // Visitor Pattern

        ArrayLiteral: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var text = self.text.join(", ");
                self.popScope();
                self.append("[" + text + "]");
            });
            tw.walk('elements');
            this.freshScope();
        },

        AssignmentExpression: function (tw, parent, obj, name) {
            var result, self = this;
            tw.invoke(function () { self.needsTermination = true; });
            result = this.BinaryExpression(tw, parent, obj, name);
        },

        BinaryExpression: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var lhs, rhs;
                rhs = self.text.join("");
                self.popScope();
                lhs = self.text.join("");
                self.popScope();
                self.append(lhs + " " + obj.operator + " " + rhs);
            });
            tw.walk('right');
            tw.invoke(function () {
                self.freshScope();
            });
            tw.walk('left');
            this.freshScope();
        },

        Block: function (tw, parent, obj, name) {
            var i, self = this, statements = [];
            this.incDepth();
            tw.invoke(function () {
                self.decDepth();
                var text = statements.join("");
                self.withFreshScopeJoin(function () {
                    self.append("{\n");
                    self.append(text);
                    self.indent();
                    self.append("}");
                });
                self.needsTermination = false;
            });
            this.formatStatements(tw, statements, obj.statements);
        },

        BooleanLiteral: function (tw, parent, obj, name) {
            this.append(obj.value);
        },

        BreakStatement: function (tw, parent, obj, name) {
            if (obj.label) {
                this.append("break " + obj.label);
            } else {
                this.append("break");
            }
        },

        CaseClause: function (tw, parent, obj, name) {
            var i, self = this, statements = [];
            this.incDepth();
            tw.invoke(function () {
                var text, selector;
                self.decDepth();
                text = statements.join("");
                selector = self.text.join("");
                self.popScope();
                self.append("case " + selector + ":\n" + text);
                self.needsTermination = false;
            });
            tw.walk('selector');
            tw.invoke(function () { self.freshScope(); });
            this.formatStatements(tw, statements, obj.statements);
        },

        Catch: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append(" catch (" + obj.identifier + ") " + body);
                self.needsTermination = false;
            });
            tw.walk('block');
            this.freshScope();
        },

        ConditionalExpression: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var cond, trueExpr, falseExpr;
                falseExpr = self.text.join("");
                self.popScope();
                trueExpr = self.text.join("");
                self.popScope();
                cond = self.text.join("");
                self.popScope();
                // TODO: the surrounding parenthesis are not always needed
                self.append("(" + cond + " ? " + trueExpr + " : " + falseExpr + ")");
            });
            tw.walk('falseExpression');
            tw.invoke(function () {
                self.freshScope();
            });
            tw.walk('trueExpression');
            tw.invoke(function () {
                self.freshScope();
            });
            tw.walk('condition');
            this.freshScope();
        },

        ContinueStatement: function (tw, parent, obj, name) {
            if (obj.label) {
                this.append("continue " + obj.label);
            } else {
                this.append("continue");
            }
        },

        DebuggerStatement: function (tw, parent, obj, name) {
            this.append("debugger");
        },

        DefaultClause: function (tw, parent, obj, name) {
            var i, self = this, statements = [];
            this.incDepth();
            tw.invoke(function () {
                self.decDepth();
                var text = statements.join("");
                self.append("default:\n" + text);
                self.needsTermination = false;
            });
            this.formatStatements(tw, statements, obj.statements);
        },

        DoWhileStatement: function (tw, parent, obj, name) {
            var condition, self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.withFreshScopeJoin(function () {
                    self.append("do");
                    if (obj.statement.type === "Block") {
                        self.append(" ");
                        self.append(body);
                        self.append(" ");
                    } else {
                        self.append("\n");
                        self.incDepth();
                        self.indent();
                        self.decDepth();
                        self.append(body);
                        self.terminate();
                        self.append("\n");
                        self.indent();
                    }
                    self.append("while (" + condition + ")");
                });
                self.needsTermination = true;
            });
            tw.walk('statement');
            tw.invoke(function () {
                condition = self.text.join("");
                self.popAndFreshScope();
            });
            tw.walk('condition');
            this.freshScope();
        },

        EmptyStatement: function (tw, parent, obj, name) {
            this.needsTermination = false;
        },

        Finally: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append(" finally " + body);
                self.needsTermination = false;
            });
            tw.walk('block');
            this.freshScope();
        },

        ForInStatement: function (tw, parent, obj, name) {
            this.forWhileLoop(
                tw, ['iterator', 'collection'], obj,
                function (elements) {
                    if ("VariableDeclaration" === obj.iterator.type) {
                        elements.iterator = "var " + elements.iterator;
                    }
                    return "for (" + elements.iterator + " in " +
                        elements.collection + ")";
                });
        },

        ForStatement: function (tw, parent, obj, name) {
            this.forWhileLoop(
                tw, ['initializer', 'test', 'counter'], obj,
                function (elements) {
                    return "for (" + elements.initializer + "; " +
                        elements.test + "; " + elements.counter + ")";
                });
        },

        Function: function (tw, parent, obj, name) {
            var i, self = this, statements = [];
            this.incDepth();
            tw.invoke(function () {
                self.decDepth();
                var text = statements.join("");
                self.withFreshScopeJoin(function () {
                    self.append("function ");
                    if (obj.name) {
                        self.append(obj.name + " ");
                    }
                    self.append("(");
                    self.append(obj.params.join(", "));
                    self.append(") {\n");
                    self.append(text);
                    self.indent();
                    self.append("}");
                });
                self.needsTermination = false;
            });
            this.formatStatements(tw, statements, obj.elements);
        },

        FunctionCall: function (tw, parent, obj, name) {
            var args, self = this;
            tw.invoke(function () {
                var name, postfix;
                name = self.text.join("");
                postfix = "";
                self.popScope();
                self.withFreshScopeJoin(function () {
                    if ("Function" === obj.name.type) {
                        self.append("(" + name);
                        postfix = ")";
                    } else {
                        self.append(name);
                    }
                    self.append("(" + args + ")" + postfix);
                });
            });
            tw.walk('name');
            tw.invoke(function () {
                var text = self.text.join(", ");
                args = text;
                self.popAndFreshScope();
            });
            tw.walk('arguments');
            this.freshScope();
        },

        GetterDefinition: function (tw, parent, obj, name) {
            var i, self = this, statements = [];
            this.incDepth();
            tw.invoke(function () {
                self.decDepth();
                var text = statements.join("");
                self.withFreshScopeJoin(function () {
                    self.append("get " + obj.name + "() {\n");
                    self.append(text);
                    self.indent();
                    self.append("}");
                });
            });
            this.formatStatements(tw, statements, obj.body);
        },

        IfStatement: function (tw, parent, obj, name) {
            var condition, trueSt, falseSt, formatBranch, self = this;

            formatBranch = function (text, branch, postfix) {
                if ("Block" === branch.type) {
                    self.append(" ");
                } else {
                    self.append("\n");
                    self.incDepth();
                    self.indent();
                    self.decDepth();
                }
                self.append(text);
                if (postfix) {
                    if ("Block" === branch.type) {
                        self.append(" ");
                        self.append(postfix);
                    } else {
                        self.append("\n");
                        self.indent();
                        self.append(postfix);
                    }
                }
            };

            this.incDepth();
            if (obj.elseStatement) {
                tw.invoke(function () {
                    falseSt = self.text.join("");
                    self.popScope();
                    self.withFreshScopeJoin(function () {
                        self.append("if (" + condition + ")");
                        formatBranch(trueSt, obj.ifStatement, "else");
                        formatBranch(falseSt, obj.elseStatement);
                    });
                    self.needsTermination = false;
                });
                tw.walk('elseStatement');
                tw.invoke(function () {
                    trueSt = self.text.join("");
                    self.popAndFreshScope();
                });
            } else {
                tw.invoke(function () {
                    trueSt = self.text.join("");
                    self.popScope();
                    self.withFreshScopeJoin(function () {
                        self.append("if (" + condition + ")");
                        formatBranch(trueSt, obj.ifStatement);
                        condition = self.text.join("");
                    });
                    self.needsTermination = false;
                });
            }
            tw.walk('ifStatement');
            tw.invoke(function () {
                self.decDepth();
                condition = self.text.join("");
                self.popAndFreshScope();
            });
            tw.walk('condition');
            this.freshScope();
        },

        LabelledStatement: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var statement = self.text.join("");
                self.popScope();
                self.append(obj.label + ": " + statement);
            });
            tw.walk('statement');
            this.freshScope();
        },

        NewOperator: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var ctr, args;
                args = self.text.join(", ");
                self.popScope();
                ctr = self.text.join("");
                self.popScope();
                self.append("new " + ctr + "(" + args + ")");
            });
            tw.walk('arguments');
            tw.invoke(function () { self.freshScope(); });
            tw.walk('constructor');
            this.freshScope();
        },

        NullLiteral: function (tw, parent, obj, name) {
            this.append("null");
        },

        NumericLiteral: function (tw, parent, obj, name) {
            this.append(obj.value);
        },

        ObjectLiteral: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var props = self.text.join(", ");
                self.popScope();
                self.append("{" + props + "}");
            });
            tw.walk('properties');
            this.freshScope();
        },

        PostfixExpression: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var expression = self.text.join("");
                self.popScope();
                self.append(expression + obj.operator);
            });
            tw.walk('expression');
            this.freshScope();
        },

        Program: function (tw, parent, obj, name) {
            var i, self = this, elements = [];
            tw.invoke(function () { self.append(elements.join("")); });
            this.formatStatements(tw, elements, obj.elements);
        },

        PropertyAccess: function (tw, parent, obj, name) {
            var field, self = this, simple = String === obj.name.constructor;
            tw.invoke(function () {
                var base = self.text.join("");
                self.popScope();
                if (simple) {
                    self.append(base + "." + field);
                } else {
                    self.append(base + "[" + field + "]");
                }
            });
            tw.walk('base');
            this.freshScope();
            if (simple) {
                field = obj.name;
            } else {
                tw.invoke(function () {
                    field = self.text.join("");
                    self.popAndFreshScope();
                });
                tw.walk('name');
            }
        },

        PropertyAssignment: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var value = self.text.join("");
                self.popScope();
                self.append(obj.name + ": " + value);
            });
            tw.walk('value');
            this.freshScope();
        },

        RegularExpressionLiteral: function (tw, parent, obj, name) {
            this.append("/" + obj.body + "/" + obj.flags);
        },

        ReturnStatement: function (tw, parent, obj, name) {
            var self;
            if (obj.value) {
                self = this;
                tw.invoke(function () {
                    var value = self.text.join("");
                    self.popScope();
                    self.append("return " + value);
                });
                tw.walk('value');
                this.freshScope();
            } else {
                this.append("return");
            }
        },

        SetterDefinition: function (tw, parent, obj, name) {
            var i, self = this, statements = [];
            this.incDepth();
            tw.invoke(function () {
                self.decDepth();
                var text = statements.join("");
                self.withFreshScopeJoin(function () {
                    self.append("set " + obj.name + "(" + obj.param + ") {\n");
                    self.append(text);
                    self.indent();
                    self.append("}");
                });
            });
            this.formatStatements(tw, statements, obj.body);
        },

        StringLiteral: function (tw, parent, obj, name) {
            var str = obj.value;
            str = str.replace(/\\/g, "\\\\");
            str = str.replace(/\'/g, "\\\'");
            str = str.replace(/\"/g, '\\\"');
            str = str.replace(/[\b]/g, "\\b"); // \b on its own matches boundary
            str = str.replace(/\f/g, "\\f");
            str = str.replace(/\r/g, "\\r");
            str = str.replace(/\n/g, "\\n");
            str = str.replace(/\t/g, "\\t");
            this.append('"' + str + '"');
        },

        SwitchStatement: function (tw, parent, obj, name) {
            var i, self = this, clauses = [];
            tw.invoke(function () {
                var condition, body;
                self.decDepth();
                condition = self.text.join("");
                self.popScope();
                self.withFreshScopeJoin(function () {
                    body = clauses.join("");
                    self.append("switch (" + condition + ") {\n");
                    self.append(body);
                    self.indent();
                    self.append("}");
                });
                self.needsTermination = false;
            });
            tw.walk('expression');
            tw.invoke(function () {
                self.freshScope();
                self.incDepth();
            });
            this.formatStatements(tw, clauses, obj.clauses);
        },

        This: function (tw, parent, obj, name) {
            this.append("this");
        },

        ThrowStatement: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append("throw " + body);
            });
            tw.walk('exception');
            this.freshScope();
        },

        TryStatement: function (tw, parent, obj, name) {
            var self = this;
            if (obj['finally']) {
                tw.walk('finally');
            }
            tw.walk('catch');
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append("try " + body);
                self.needsTermination = false;
            });
            tw.walk('block');
            this.freshScope();
        },

        UnaryExpression: function (tw, parent, obj, name) {
            var self = this;
            tw.invoke(function () {
                var text = self.text.join("");
                self.popScope();
                if (obj.operator.length > 2) { // delete, typeof, or void
                    self.append(obj.operator + " " + text);
                } else { // ++, --, +, -, ~, !
                    self.append(obj.operator + text);
                }
            });
            tw.walk('expression');
            this.freshScope();
        },

        Variable: function (tw, parent, obj, name) {
            this.append(obj.name);
        },

        VariableDeclaration: function (tw, parent, obj, name) {
            var self = this;
            if (obj.value) {
                tw.invoke(function () {
                    var value = self.text.join("");
                    self.popScope();
                    self.append(obj.name + " = " + value);
                });
                tw.walk('value');
                this.freshScope();
            } else {
                this.append(obj.name);
            }
        },

        VariableStatement: function (tw, parent, obj, name) {
            var i, self = this;
            self = this;
            tw.invoke(function () {
                var decls = self.text.join(", ");
                self.popScope();
                self.append("var " + decls);
                self.needsTermination = true;
            });
            tw.walk('declarations');
            this.freshScope();
        },

        WhileStatement: function (tw, parent, obj, name) {
            this.forWhileLoop(
                tw, ['condition'], obj,
                function (elements) {
                    return "while (" + elements.condition + ")";
                });
        },

        WithStatement: function (tw, parent, obj, name) {
            this.forWhileLoop(
                tw, ['environment'], obj,
                function (elements) {
                    return "with (" + elements.environment + ")";
                });
        }
    };

    function ProxyInjector(ast, atomize) {
        this.ast = ast;
        this.treeWalker = new TreeWalker(ast, this);
        if (undefined !== atomize) {
            this.atomize = atomize;
        }
    }

    ProxyInjector.prototype = {

        atomize: 'atomize',

        transform: function () {
            this.treeWalker.traverse();
        },

        AssignmentExpression: function (tw, parent, obj, name) {
            var simple, self = this;
            if (obj.left.type === 'PropertyAccess') {
                simple = String === obj.left.name.constructor;
                tw.invoke(function () {
                    var rhs, lhs, body, base, field, setter;
                    base = new PrettyPrinter(obj.left.base).print();
                    rhs = new PrettyPrinter(obj.right).print();

                    if (simple) {
                        field = obj.left.name;
                        setter = "'" + field + "'";
                    } else {
                        field = new PrettyPrinter(obj.left.name).print();
                        setter = field;
                    }
                    body = self.atomize + ".assign(" + base + ", " + setter + ", " + rhs + ")";
                    parent[name] = parser.parse(body).elements[0];
                });
                tw.walk(obj.left, 'base');
                if (!simple) {
                    tw.walk(obj.left, 'name');
                }
            } else {
                tw.walk('left');
            }
            tw.walk('right');
        },

        PropertyAccess: function (tw, parent, obj, name) {
            var self = this, simple = String === obj.name.constructor;
            tw.invoke(function () {
                var body, base, field, getter;
                base = new PrettyPrinter(obj.base).print();
                if (simple) {
                    field = obj.name;
                    getter = "'" + field + "'";
                } else {
                    field = new PrettyPrinter(obj.name).print();
                    getter = field;
                }
                body = self.atomize + ".access(" + base + ", " + getter + ")";
                parent[name] = parser.parse(body).elements[0];
            });
            tw.walk('base');
            if (!simple) {
                tw.walk('name');
            }
        }


    };

    exports.parse = parser.parse;
    exports.TreeWalker = TreeWalker;
    exports.PrettyPrinter = PrettyPrinter;
    exports.ProxyInjector = ProxyInjector;

    exports.test = function () {
        var ast, pi, pp;
        ast = parser.parse("a.b['c'] = d.e = f['' + g];");
        pi = new ProxyInjector(ast);
        pi.transform();
        pp = new PrettyPrinter(pi.ast);
        return pp.print();
    };

}());
