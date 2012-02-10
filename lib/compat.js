/*global require, exports */
/*jslint browser: true, devel: true */

var AtomizeCompat;

(function (window) {
    'use strict';

    if (undefined !== AtomizeCompat) {
        return;
    }

    var atomizeCompat;

    atomizeCompat = {
        loaded: false,

        load: function (stm) {
            if (this.loaded) {
                return;
            }
            this.loaded = true;

            var wrapUnary = function (parent, funName, proxyFunName) {
                var origFun = parent[funName];
                if (undefined !== origFun) {
                    if (undefined === proxyFunName) {
                        proxyFunName = funName;
                    }
                    parent[funName] = function (obj) {
                        stm.log(["compat lib invocation of ", funName]);
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(parent, obj);
                        } else {
                            return tvar.handler[proxyFunName]();
                        }
                    }
                }
            };

            (function () { // Object.defineProperty
                var origFun = Object.defineProperty;

                if (undefined !== origFun) {
                    Object.defineProperty = function (obj, name, desc) {
                        stm.log("compat lib invocation of defineProperty");
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(Object, obj, name, desc);
                        } else {
                            return tvar.handler.defineProperty(name, desc);
                        }
                    };
                }
            }());

            (function () { // Object.getPropertyDescriptor
                var origFun = Object.getPropertyDescriptor;

                if (undefined !== origFun) {
                    Object.getPropertyDescriptor = function (obj, name) {
                        stm.log("compat lib invocation of getPropertyDescriptor");
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(Object, obj, name);
                        } else {
                            return tvar.handler.getPropertyDescriptor(name);
                        }
                    };
                }
            }());

            wrapUnary(Object, 'getPropertyNames');

            (function () { // Object.getOwnPropertyDescriptor
                var origFun = Object.getOwnPropertyDescriptor;

                if (undefined !== origFun) {
                    Object.getOwnPropertyDescriptor = function (obj, name) {
                        stm.log("compat lib invocation of getOwnPropertyDescriptor");
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(Object, obj, name);
                        } else {
                            return tvar.handler.getOwnPropertyDescriptor(name);
                        }
                    };
                }
            }());

            wrapUnary(Object, 'getOwnPropertyNames');
            wrapUnary(Object, 'hasOwnProperty', 'hasOwn');
            wrapUnary(Object, 'keys');

        }
    };

    if ("undefined" === typeof exports) {
        AtomizeCompat = atomizeCompat;
    } else {
        exports.compat = atomizeCompat;
    }
}());
