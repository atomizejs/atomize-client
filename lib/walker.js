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
            [{traverse: ast, parent: undefined},
             {fun: function (state) {
                 if (self.hasProp(self.recv, 'finished') &&
                     Function === self.recv.finished.constructor) {
                     return self.recv.finished(state);
                 }
             }}];
        this.state = undefined;
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
            var item, parent, obj, keys, i, key;
            while (0 !== this.stack.length) {
                item = this.stack.shift();

                if (this.hasOwnProp(item, 'traverse')) {
                    obj = item.traverse;
                    parent = item.parent;
                    if (this.hasOwnProp(obj, "type")) {
                        this.current = obj;
                        if (this.hasProp(this.recv, obj.type) &&
                            Function === this.recv[obj.type].constructor) {
                            this.state = this.recv[obj.type](this, parent, obj, this.state);
                        } else {
                            keys = Object.keys(obj);
                            for (i = keys.length - 1; i >= 0; i -= 1) {
                                key = keys[i];
                                if (!this.isPrimitive(obj[key])) {
                                    this.stack.unshift({traverse: obj[key], parent: obj});
                                }
                            }
                        }
                    } else {
                        if (Array === obj.constructor) {
                            for (i = obj.length - 1; i >= 0; i -= 1) {
                                this.stack.unshift({traverse: obj[i], parent: parent});
                            }
                        } else {
                            if (this.hasProp(this.recv, 'unknown') &&
                                Function === this.recv.unknown.constructor) {
                                this.state = this.recv.unknown(this, parent, obj, this.state);
                            }
                        }
                    }
                } else if (this.hasOwnProp(item, 'fun')) {
                    this.current = item.current;
                    this.state = item.fun(this, item.current, this.state);
                }
            }
        },

        walk: function (obj) {
            this.stack.unshift({traverse: obj, parent: this.current});
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
                tw.walk(obj[i]);
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
            tw.walk(obj.statement);
            for (i = 0; i < elements.length; i += 1) {
                (function () {
                    var j = i;
                    if (obj[elements[j]]) {
                        tw.invoke(function () {
                            elements[elements[j]] = self.text.join("");
                            self.popAndFreshScope();
                        });
                        tw.walk(obj[elements[j]]);
                    } else {
                        elements[elements[j]] = '';
                    }
                }());
            }
            this.freshScope();
        },

        // Visitor Pattern

        ArrayLiteral: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var text = self.text.join(", ");
                self.popScope();
                self.append("[" + text + "]");
            });
            tw.walk(obj.elements);
            this.freshScope();
            return state;
        },

        AssignmentExpression: function (tw, parent, obj, state) {
            var result, self = this;
            tw.invoke(function () { self.needsTermination = true; });
            result = this.BinaryExpression(tw, parent, obj, state);
            return result;
        },

        BinaryExpression: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var lhs, rhs;
                rhs = self.text.join("");
                self.popScope();
                lhs = self.text.join("");
                self.popScope();
                self.append(lhs + " " + obj.operator + " " + rhs);
            });
            tw.walk(obj.right);
            tw.invoke(function () {
                self.freshScope();
            });
            tw.walk(obj.left);
            this.freshScope();
            return state;
        },

        Block: function (tw, parent, obj, state) {
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
            return state;
        },

        BooleanLiteral: function (tw, parent, obj, state) {
            this.append(obj.value);
            return state;
        },

        BreakStatement: function (tw, parent, obj, state) {
            if (obj.label) {
                this.append("break " + obj.label);
            } else {
                this.append("break");
            }
            return state;
        },

        CaseClause: function (tw, parent, obj, state) {
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
            tw.walk(obj.selector);
            tw.invoke(function () { self.freshScope(); });
            this.formatStatements(tw, statements, obj.statements);
            return state;
        },

        Catch: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append(" catch (" + obj.identifier + ") " + body);
                self.needsTermination = false;
            });
            tw.walk(obj.block);
            this.freshScope();
            return state;
        },

        ConditionalExpression: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var cond, trueExpr, falseExpr;
                falseExpr = self.text.join("");
                self.popScope();
                trueExpr = self.text.join("");
                self.popScope();
                cond = self.text.join("");
                self.popScope();
                self.append(cond + " ? " + trueExpr + " : " + falseExpr);
            });
            tw.walk(obj.falseExpression);
            tw.invoke(function () {
                self.freshScope();
            });
            tw.walk(obj.trueExpression);
            tw.invoke(function () {
                self.freshScope();
            });
            tw.walk(obj.condition);
            this.freshScope();
            return state;
        },

        ContinueStatement: function (tw, parent, obj, state) {
            if (obj.label) {
                this.append("continue " + obj.label);
            } else {
                this.append("continue");
            }
            return state;
        },

        DebuggerStatement: function (tw, parent, obj, state) {
            this.append("debugger");
            return state;
        },

        DefaultClause: function (tw, parent, obj, state) {
            var i, self = this, statements = [];
            this.incDepth();
            tw.invoke(function () {
                self.decDepth();
                var text = statements.join("");
                self.append("default:\n" + text);
                self.needsTermination = false;
            });
            this.formatStatements(tw, statements, obj.statements);
            return state;
        },

        DoWhileStatement: function (tw, parent, obj, state) {
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
            tw.walk(obj.statement);
            tw.invoke(function () {
                condition = self.text.join("");
                self.popAndFreshScope();
            });
            tw.walk(obj.condition);
            this.freshScope();
            return state;
        },

        EmptyStatement: function (tw, parent, obj, state) {
            this.needsTermination = false;
            return state;
        },

        Finally: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append(" finally " + body);
                self.needsTermination = false;
            });
            tw.walk(obj.block);
            this.freshScope();
            return state;
        },

        ForInStatement: function (tw, parent, obj, state) {
            this.forWhileLoop(
                tw, ['iterator', 'collection'], obj,
                function (elements) {
                    if ("VariableDeclaration" === obj.iterator.type) {
                        elements.iterator = "var " + elements.iterator;
                    }
                    return "for (" + elements.iterator + " in " +
                        elements.collection + ")";
                });
            return state;
        },

        ForStatement: function (tw, parent, obj, state) {
            this.forWhileLoop(
                tw, ['initializer', 'test', 'counter'], obj,
                function (elements) {
                    return "for (" + elements.initializer + "; " +
                        elements.test + "; " + elements.counter + ")";
                });
            return state;
        },

        Function: function (tw, parent, obj, state) {
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
            return state;
        },

        FunctionCall: function (tw, parent, obj, state) {
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
            tw.walk(obj.name);
            tw.invoke(function () {
                var text = self.text.join(", ");
                args = text;
                self.popAndFreshScope();
            });
            tw.walk(obj['arguments']);
            this.freshScope();
            return state;
        },

        GetterDefinition: function (tw, parent, obj, state) {
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
            return state;
        },

        IfStatement: function (tw, parent, obj, state) {
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
                tw.walk(obj.elseStatement);
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
            tw.walk(obj.ifStatement);
            tw.invoke(function () {
                self.decDepth();
                condition = self.text.join("");
                self.popAndFreshScope();
            });
            tw.walk(obj.condition);
            this.freshScope();
            return state;
        },

        LabelledStatement: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var statement = self.text.join("");
                self.popScope();
                self.append(obj.label + ": " + statement);
            });
            tw.walk(obj.statement);
            this.freshScope();
            return state;
        },

        NewOperator: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var ctr, args;
                args = self.text.join(", ");
                self.popScope();
                ctr = self.text.join("");
                self.popScope();
                self.append("new " + ctr + "(" + args + ")");
            });
            tw.walk(obj['arguments']);
            tw.invoke(function () { self.freshScope(); });
            tw.walk(obj.constructor);
            this.freshScope();
            return state;
        },

        NullLiteral: function (tw, parent, obj, state) {
            this.append("null");
            return state;
        },

        NumericLiteral: function (tw, parent, obj, state) {
            this.append(obj.value);
            return state;
        },

        ObjectLiteral: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var props = self.text.join(", ");
                self.popScope();
                self.append("{" + props + "}");
            });
            tw.walk(obj.properties);
            this.freshScope();
            return state;
        },

        PostfixExpression: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var expression = self.text.join("");
                self.popScope();
                self.append(expression + obj.operator);
            });
            tw.walk(obj.expression);
            this.freshScope();
            return state;
        },

        Program: function (tw, parent, obj, state) {
            var i, self = this, elements = [];
            tw.invoke(function () { self.append(elements.join("")); });
            this.formatStatements(tw, elements, obj.elements);
            return state;
        },

        PropertyAccess: function (tw, parent, obj, state) {
            var name, self = this, simple = String === obj.name.constructor;
            tw.invoke(function () {
                var base = self.text.join("");
                self.popScope();
                if (simple) {
                    self.append(base + "." + name);
                } else {
                    self.append(base + "[" + name + "]");
                }
            });
            tw.walk(obj.base);
            this.freshScope();
            if (simple) {
                name = obj.name;
            } else {
                tw.invoke(function () {
                    name = self.text.join("");
                    self.popAndFreshScope();
                });
                tw.walk(obj.name);
            }
            return state;
        },

        PropertyAssignment: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var value = self.text.join("");
                self.popScope();
                self.append(obj.name + ": " + value);
            });
            tw.walk(obj.value);
            this.freshScope();
            return state;
        },

        RegularExpressionLiteral: function (tw, parent, obj, state) {
            this.append("/" + obj.body + "/" + obj.flags);
            return state;
        },

        ReturnStatement: function (tw, parent, obj, state) {
            var self;
            if (obj.value) {
                self = this;
                tw.invoke(function () {
                    var value = self.text.join("");
                    self.popScope();
                    self.append("return " + value);
                });
                tw.walk(obj.value);
                this.freshScope();
            } else {
                this.append("return");
            }
            return state;
        },

        SetterDefinition: function (tw, parent, obj, state) {
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
            return state;
        },

        StringLiteral: function (tw, parent, obj, state) {
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
            return state;
        },

        SwitchStatement: function (tw, parent, obj, state) {
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
            tw.walk(obj.expression);
            tw.invoke(function () {
                self.freshScope();
                self.incDepth();
            });
            this.formatStatements(tw, clauses, obj.clauses);
            return state;
        },

        This: function (tw, parent, obj, state) {
            this.append("this");
            return state;
        },

        ThrowStatement: function (tw, parent, obj, state) {
            var self = this;
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append("throw " + body);
            });
            tw.walk(obj.exception);
            this.freshScope();
            return state;
        },

        TryStatement: function (tw, parent, obj, state) {
            var self = this;
            if (obj['finally']) {
                tw.walk(obj['finally']);
            }
            tw.walk(obj['catch']);
            tw.invoke(function () {
                var body = self.text.join("");
                self.popScope();
                self.append("try " + body);
                self.needsTermination = false;
            });
            tw.walk(obj.block);
            this.freshScope();
            return state;
        },

        UnaryExpression: function (tw, parent, obj, state) {
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
            tw.walk(obj.expression);
            this.freshScope();
            return state;
        },

        Variable: function (tw, parent, obj, state) {
            this.append(obj.name);
            return state;
        },

        VariableDeclaration: function (tw, parent, obj, state) {
            var self = this;
            if (obj.value) {
                tw.invoke(function () {
                    var value = self.text.join("");
                    self.popScope();
                    self.append(obj.name + " = " + value);
                });
                tw.walk(obj.value);
                this.freshScope();
            } else {
                this.append(obj.name);
            }
            return state;
        },

        VariableStatement: function (tw, parent, obj, state) {
            var i, self = this;
            self = this;
            tw.invoke(function () {
                var decls = self.text.join(", ");
                self.popScope();
                self.append("var " + decls);
                self.needsTermination = true;
            });
            tw.walk(obj.declarations);
            this.freshScope();
            return state;
        },

        WhileStatement: function (tw, parent, obj, state) {
            this.forWhileLoop(
                tw, ['condition'], obj,
                function (elements) {
                    return "while (" + elements.condition + ")";
                });
            return state;
        },

        WithStatement: function (tw, parent, obj, state) {
            this.forWhileLoop(
                tw, ['environment'], obj,
                function (elements) {
                    return "with (" + elements.environment + ")";
                });
            return state;
        }
    };

    exports.parse = parser.parse;
    exports.TreeWalker = TreeWalker;
    exports.PrettyPrinter = PrettyPrinter;

}());
