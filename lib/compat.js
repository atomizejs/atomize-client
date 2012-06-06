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
                if (undefined !== origFun && undefined === origFun._origFun) {
                    if (undefined === proxyFunName) {
                        proxyFunName = funName;
                    }
                    parent[funName] = (function (obj) {
                        stm.log(["compat lib invocation of ", funName]);
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(parent, obj);
                        } else {
                            return tvar.handler[proxyFunName]();
                        }
                    }).bind(parent);
                    parent[funName]._origFun = origFun.bind(parent);
                }
            };

            (function () { // Object.defineProperty
                var origFun = Object.defineProperty;

                if (undefined !== origFun && undefined === origFun._origFun) {
                    Object.defineProperty = (function (obj, name, desc) {
                        stm.log("compat lib invocation of defineProperty");
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(Object, obj, name, desc);
                        } else {
                            return tvar.handler.defineProperty(name, desc);
                        }
                    }).bind(Object);
                    Object.defineProperty._origFun = origFun.bind(Object);
                }
            }());

            (function () { // Object.getPropertyDescriptor
                var origFun = Object.getPropertyDescriptor;

                if (undefined !== origFun && undefined === origFun._origFun) {
                    Object.getPropertyDescriptor = (function (obj, name) {
                        stm.log("compat lib invocation of getPropertyDescriptor");
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(Object, obj, name);
                        } else {
                            return tvar.handler.getPropertyDescriptor(name);
                        }
                    }).bind(Object);
                    Object.getPropertyDescriptor._origFun = origFun.bind(Object);
                }
            }());

            wrapUnary(Object, 'getPropertyNames');

            (function () { // Object.getOwnPropertyDescriptor
                var origFun = Object.getOwnPropertyDescriptor;

                if (undefined !== origFun && undefined === origFun._origFun) {
                    Object.getOwnPropertyDescriptor = (function (obj, name) {
                        stm.log("compat lib invocation of getOwnPropertyDescriptor");
                        var tvar = stm.asTVar(obj);
                        if (undefined === tvar) {
                            return origFun.call(Object, obj, name);
                        } else {
                            return tvar.handler.getOwnPropertyDescriptor(name);
                        }
                    }).bind(Object);
                    Object.getOwnPropertyDescriptor._origFun = origFun.bind(Object);
                }
            }());

            wrapUnary(Object, 'getOwnPropertyNames');
            wrapUnary(Object, 'keys');

            (function () { // hasOwnProperty NOTE: no bind!
                var objProto = Object.getPrototypeOf({});
                var origFun = objProto.hasOwnProperty;

                if (undefined !== origFun && undefined === origFun._origFun) {
                    objProto.hasOwnProperty = function (name) {
                        stm.log("compat lib invocation of hasOwnProperty");
                        var tvar = stm.asTVar(this);
                        if (undefined === tvar) {
                            return origFun.call(this, name);
                        } else {
                            return tvar.handler.has(name);
                        }
                    };
                    Object.hasOwnProperty._origFun = origFun;
                }
            }());
        }
    };

    if ("undefined" !== typeof Proxy) {
        atomizeCompat.loaded = true;
    }

    if ("undefined" === typeof exports) {
        AtomizeCompat = atomizeCompat;
    } else {
        exports.compat = atomizeCompat;
    }

}());
