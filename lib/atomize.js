/*global WeakMap, Map, Proxy, SockJS, Cereal, exports, require */
/*jslint browser: true, devel: true */

var Atomize;

function NotATVarException() {}
NotATVarException.prototype = {
    prototype: Error.prototype,
    toString: function () {return "Not A TVar";}
};

function WriteOutsideTransactionException() {}
WriteOutsideTransactionException.prototype = {
    prototype: Error.prototype,
    toString: function () {return "Write outside transaction";}
};

function DeleteOutsideTransactionException() {}
DeleteOutsideTransactionException.prototype = {
    prototype: Error.prototype,
    toString: function () {return "Delete outside transaction";}
};

function RetryOutsideTransactionException() {}
RetryOutsideTransactionException.prototype = {
    prototype: Error.prototype,
    toString: function () {return "Retry outside transaction";}
};

function InternalException() {}
InternalException.prototype = {
    prototype: Error.prototype,
    toString: function () {return "Internal Exception";}
};

(function (window) {
    'use strict';

    var util, STM, Cereal, events;

    if (typeof exports !== "undefined") {
        Cereal = require('cereal');
        events = require('events');

    } else {
        Cereal = window.Cereal;

        if (typeof Cereal === "undefined") {
            console.error("Please load the cereal.js script before the atomize.js script.");
            return;
        }
    }

    util = (function () {
        return {
            isPrimitive: function (obj) {
                return obj !== Object(obj);
            },

            hasOwnProp: ({}).hasOwnProperty,

            shallowCopy: function (src, dest) {
                var keys, i;
                keys = Object.keys(src);
                for (i = 0; i < keys.length; i += 1) {
                    dest[keys[i]] = src[keys[i]];
                }
            },

            lift: function (src, dest, fields) {
                var i;
                for (i = 0; i < fields.length; i += 1) {
                    dest[fields[i]] = src[fields[i]].bind(src);
                }
            }
        };
    }());

    (function () {

        function TVar(id, obj, stm) {
            this.id = id;
            this.raw = obj;
            this.isArray = Array === obj.constructor;
            this.stm = stm;
            this.version = 0;
            this.handler = this.objHandlerMaker();
            this.proxied = this.createProxy(this.handler, Object.getPrototypeOf(obj));
        }

        TVar.prototype = {

            hasNativeProxy: "undefined" !== typeof Proxy,

            log: function (msgs) {
                if (typeof msgs === "string") {
                    this.stm.log(["[TVar ", this.id, "] ", msgs]);
                } else {
                    this.stm.log(["[TVar ", this.id, "] "].concat(msgs));
                }
            },

            clone: function (obj) {
                // provided the .proxy is different from the .raw then
                // we're ok. But in a few places we also need to make
                // sure the prototype of the .proxy matches the
                // prototype of the .raw (in order to correctly walk
                // down the prototype chain), hence this method.
                var result, keys, i, ctr = function () {};
                ctr.prototype = Object.getPrototypeOf(obj);
                result = new ctr();
                util.shallowCopy(obj, result);
                return result;
            },

            createProxy: function (handler, proto) {
                if (this.hasNativeProxy) {
                    return Proxy.create(handler, proto);
                } else {
                    return this.clone(this.raw);
                }
            },

            objHandlerMaker: function () {
                var self, stm, result;

                self = this;
                stm = self.stm;

                result = {

                    getOwnPropertyDescriptor: function (name) {
                        self.log(["getOwnPropertyDescriptor: ", name]);
                        var desc;
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        if ("_map" === name || ! stm.inTransaction()) {
                            desc = Object.getOwnPropertyDescriptor(self.raw, name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return undefined;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                desc = Object.getOwnPropertyDescriptor(self.raw, name);
                            }
                        }
                        if (undefined !== desc && util.hasOwnProp.call(desc, 'configurable')) {
                            desc.configurable = true; // should go away with direct proxies
                        }
                        return desc;
                    },

                    getPropertyDescriptor: function (name) {
                        self.log(["getPropertyDescriptor: ", name]);
                        var desc, tmp, proto;
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        if (undefined === Object.getPropertyDescriptor) {
                            tmp = undefined;
                            proto = self.proxied;
                            while (proto !== undefined && proto !== null && proto !== tmp) {
                                tmp = proto;
                                if ("_map" === name || ! stm.inTransaction()) {
                                    desc = Object.getOwnPropertyDescriptor(tmp, name);
                                } else if (stm.transactionFrame.isDeleted(tmp, name)) {
                                    return undefined;
                                } else {
                                    desc = stm.transactionFrame.get(tmp, name);
                                    if (undefined === desc) {
                                        desc = Object.getOwnPropertyDescriptor(tmp, name);
                                    }
                                }
                                if (undefined === desc) {
                                    proto = Object.getPrototypeOf(tmp);
                                } else {
                                    if (undefined !== desc && util.hasOwnProp.call(desc, 'configurable')) {
                                        desc.configurable = true; // should go away with direct proxies
                                    }
                                    return desc;
                                }
                            }
                            return undefined;
                        } else {
                            if ("_map" === name || ! stm.inTransaction()) {
                                desc = Object.getPropertyDescriptor(self.raw, name);
                            } else if (stm.transactionFrame.isDeleted(self, name)) {
                                return undefined;
                            } else {
                                desc = stm.transactionFrame.get(self, name);
                                if (undefined === desc) {
                                    desc = Object.getPropertyDescriptor(self.raw, name);
                                }
                            }
                            if (undefined !== desc && util.hasOwnProp.call(desc, 'configurable')) {
                                desc.configurable = true; // should go away with direct proxies
                            }
                            return desc;
                        }
                    },

                    getOwnPropertyNames: function () {
                        self.log("getOwnPropertyNames");
                        stm.recordRead(self);
                        var names, result, i;
                        if (stm.inTransaction()) {
                            names = stm.transactionFrame.getOwnPropertyNames(self).concat(
                                Object.getOwnPropertyNames(self.raw));
                            result = {};
                            for (i = 0; i < names.length; i += 1) {
                                if (! stm.transactionFrame.isDeleted(self, names[i])) {
                                    result[names[i]] = true;
                                }
                            }
                            return Object.keys(result);
                        } else {
                            return Object.getOwnPropertyNames(self.raw);
                        }
                    },

                    getPropertyNames: function () {
                        self.log("getPropertyNames");
                        stm.recordRead(self);
                        var result, seen, tmp, names, proto, i;
                        result = [];
                        seen = {};
                        tmp = undefined;
                        proto = self.proxied;
                        while (proto !== undefined && proto !== null && proto !== tmp) {
                            tmp = proto;
                            names = Object.getOwnPropertyNames(tmp);
                            for (i = 0; i < names.length; i += 1) {
                                if (! util.hasOwnProp.call(seen, names[i])) {
                                    seen[names[i]] = true;
                                    result.push(names[i]);
                                }
                            }
                            proto = Object.getPrototypeOf(tmp);
                        }
                        return result;
                    },

                    defineProperty: function (name, desc) {
                        self.log(["defineProperty: ", name]);
                        if ("_map" === name) {
                            return Object.defineProperty(self.raw, name, desc);
                        }
                        if (stm.inTransaction()) {
                            if (util.hasOwnProp.call(desc, 'value') &&
                                (util.isPrimitive(desc.value) ||
                                 stm.isProxied(desc.value))) {
                                stm.transactionFrame.recordDefine(self, name, desc);
                                return self.proxied;
                            } else {
                                // the value is not a tvar, explode
                                throw new NotATVarException();
                            }
                        } else {
                            throw new WriteOutsideTransactionException();
                        }
                        return Object.defineProperty(self.raw, name, desc);
                    },

                    erase: function (name) {
                        self.log(["delete: ", name]);
                        if ("_map" === name) {
                            delete self.raw[name];
                        } else if (stm.inTransaction()) {
                            stm.transactionFrame.recordDelete(self, name);
                            // Just like in set: we don't do the delete here
                        } else {
                            throw new DeleteOutsideTransactionException();
                        }
                        return true; // TODO - lookup when this shouldn't return true
                    },

                    fix: function () {
                        // TODO - make transaction aware. Somehow. Might not be possible...
                        self.log("*** fix ***");
                        if (Object.isFrozen(self.raw)) {
                            var result = {};
                            Object.getOwnPropertyNames(self.raw).forEach(function (name) {
                                result[name] = Object.getOwnPropertyDescriptor(self.raw, name);
                            });
                            return result;
                        }
                        // As long as obj is not frozen, the proxy won't allow
                        // itself to be fixed
                        return undefined; // will cause a TypeError to be thrown
                    },

                    has: function (name) {
                        self.log(["has: ", name]);
                        var desc;
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        if ("_map" === name || ! stm.inTransaction()) {
                            return name in self.raw;
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return false;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                return name in self.raw;
                            } else {
                                return true;
                            }
                        }
                    },

                    hasOwn: function (name) {
                        self.log(["hasOwn: ", name]);
                        var desc;
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        if ("_map" == name || ! stm.inTransaction()) {
                            return util.hasOwnProp.call(self.raw, name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return false;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                return util.hasOwnProp.call(self.raw, name);
                            } else {
                                return true;
                            }
                        }
                    },

                    get: function (receiver, name) {
                        self.log(["get: ", name]);
                        var result, proxied, desc, tvar;
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        if ("_map" === name || "__proto__" === name || ! stm.inTransaction()) {
                            return self.raw[name];
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            self.log("...has been deleted");
                            return undefined;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                if (util.hasOwnProp.call(self.raw, name)) {
                                    result = self.raw[name];
                                    if (undefined === result || util.isPrimitive(result)) {
                                        self.log("...found and not object");
                                        return result;
                                    }
                                    if (Function === result.constructor) {
                                        self.log("...found and is a function");
                                        return result;
                                    }
                                    tvar = stm.ensureTVar(result);
                                    proxied = tvar.proxied;
                                    if (proxied === result) {
                                        self.log("...found in cache");
                                    } else {
                                        // rewrite our local graph to use the proxied version
                                        self.log("...implicity lifted");
                                        stm.transactionFrame.recordWrite(self, name, proxied);
                                    }
                                    return proxied;
                                } else {
                                    result = Object.getPrototypeOf(self.proxied);
                                    if (null === result || undefined === result ||
                                        result === self.raw || result === self.proxied) {
                                        self.log("...not found");
                                        return undefined;
                                    }
                                    self.log("...deferring to prototype");
                                    return stm.access(stm.ensureTVar(result).proxied, name);
                                }
                            } else {
                                self.log("...found in txn log");
                                return desc.value;
                            }
                        }
                    },

                    set: function (receiver, name, val) {
                        self.log(["set: ", name]);
                        if ("_map" === name) {
                            self.raw[name] = val;
                            return true;
                        }
                        if (stm.inTransaction()) {
                            if (undefined === val ||
                                util.isPrimitive(val) ||
                                stm.isProxied(val)) {
                                stm.transactionFrame.recordWrite(self, name, val);
                                // Note we don't actually do the write here!
                                return true;
                            } else {
                                // it's not a tvar, explode
                                throw new NotATVarException();
                            }
                        } else {
                            throw new WriteOutsideTransactionException();
                        }
                    }, // bad behavior when set fails in non-strict mode

                    enumerate: function () {
                        self.log("enumerate");
                        var result, name, keys, tmp, proto, seen, i;
                        stm.recordRead(self);
                        result = [];
                        if (stm.inTransaction()) {
                            seen = {"_map": true};
                            tmp = undefined;
                            proto = self.proxied;
                            while (undefined !== proto && null !== proto && proto !== tmp) {
                                tmp = proto;
                                keys = Object.keys(tmp);
                                for (i = 0; i < keys.length; i += 1) {
                                    if (! util.hasOwnProp.call(seen, keys[i])) {
                                        seen[keys[i]] = true;
                                        result.push(keys[i]);
                                    }
                                }
                                proto = Object.getPrototypeOf(tmp);
                            }
                            self.log(["...enumerate => ", result]);
                            return result;
                        } else {
                            for (name in self.raw) {
                                if ("_map" !== name && undefined !== name) {
                                    result.push(name);
                                }
                            }
                        }
                        return result;
                    },

                    keys: function () {
                        self.log("keys");
                        var names, seen, result, i;
                        stm.recordRead(self);
                        if (stm.inTransaction()) {
                            names = Object.keys(self.raw).concat(stm.transactionFrame.keys(self));
                            result = [];
                            seen = {"_map": true};
                            for (i = 0; i < names.length; i += 1) {
                                if (! util.hasOwnProp.call(seen, names[i])) {
                                    seen[names[i]] = true;
                                    if (! stm.transactionFrame.isDeleted(self, names[i])) {
                                        result.push(names[i]);
                                    }
                                }
                            }
                            return result;
                        } else {
                            return Object.keys(self.raw);
                        }
                    }
                };

                // disgusting hack to get around fact IE won't parse
                // JS if it sees 'delete' as a field.
                result['delete'] = result['erase'];

                return result;
            }
        };


        function Transaction(stm, id, parent, funs, cont) {
            this.stm = stm;
            this.id = id;
            this.funs = funs;
            this.funIndex = 0;
            if (undefined !== cont && undefined !== cont.call) {
                this.cont = cont;
            }
            if (undefined !== parent) {
                this.parent = parent;
            }

            this.read = {};
            this.created = {};
            this.written = {};

            this.readStack = [];
        }

        Transaction.prototype = {
            retryException: {},
            deleted: {},

            log: function (msgs) {
                if (typeof msgs === "string") {
                    this.stm.log(["[Txn ", this.id, "] ", msgs]);
                } else {
                    this.stm.log(["[Txn ", this.id, "] "].concat(msgs));
                }
            },

            reset: function (full) {
                if (0 === this.funIndex) {
                    this.readStack = [];
                } else if (Object.keys(this.read).length !== 0) {
                    this.readStack.push(this.read);
                }
                this.read = {};
                this.written = {};
                if (full) {
                    this.created = {};
                }
            },

            recordRead: function (parent) {
                this.read[parent.id] = parent.version;
            },

            recordCreation: function (value) {
                this.created[value.id] = value;
            },

            recordDelete: function (parent, name) {
                this.recordDefine(parent, name, this.deleted);
            },

            recordWrite: function (parent, name, value) {
                var desc = Object.getOwnPropertyDescriptor(parent.proxied, name);
                if (undefined === desc) {
                    desc = {value        : value,
                            enumerable   : true,
                            configurable : true,
                            writable     : true};
                } else {
                    desc.value = value;
                }

                this.recordDefine(parent, name, desc);
            },

            recordDefine: function (parent, name, descriptor) {
                if (! util.hasOwnProp.call(this.written, parent.id)) {
                    this.written[parent.id] = {tvar     : parent,
                                               children : {}};
                }
                // this could get messy - name could be 'constructor', for
                // example.
                this.written[parent.id].children[name] = descriptor;
            },

            get: function (parent, name) {
                if (util.hasOwnProp.call(this.written, parent.id) &&
                    util.hasOwnProp.call(this.written[parent.id].children, name)) {
                    if (this.deleted === this.written[parent.id].children[name]) {
                        return undefined;
                    } else {
                        return this.written[parent.id].children[name];
                    }
                }
                if (util.hasOwnProp.call(this, 'parent')) {
                    return this.parent.get(parent, name);
                } else {
                    return undefined;
                }
            },

            isDeleted: function (parent, name) {
                if (util.hasOwnProp.call(this.written, parent.id) &&
                    util.hasOwnProp.call(this.written[parent.id].children, name)) {
                    return this.deleted === this.written[parent.id].children[name];
                }
                if (util.hasOwnProp.call(this, 'parent')) {
                    return this.parent.isDeleted(parent, name);
                } else {
                    return false;
                }
            },

            keys: function (parent, predicate) {
                var result, worklist, seen, obj, vars, keys, i;
                result = [];
                worklist = [];
                seen = {};

                if (undefined === predicate) {
                    predicate = function (obj, key) {
                        return Object.getOwnPropertyDescriptor(obj, key).enumerable;
                    };
                }

                obj = this;
                while (undefined !== obj) {
                    if (util.hasOwnProp.call(obj.written, parent.id)) {
                        worklist.push(obj.written[parent.id].children);
                    }
                    obj = obj.parent;
                }
                while (0 < worklist.length) {
                    vars = worklist.shift();
                    keys = Object.keys(vars);
                    for (i = 0; i < keys.length; i += 1) {
                        if (! util.hasOwnProp.call(seen, keys[i])) {
                            seen[keys[i]] = true;
                            if ((this.deleted !== vars[keys[i]]) && predicate(vars, keys[i])) {
                                result.push(keys[i]);
                            }
                        }
                    }
                }
                return result;
            },

            getOwnPropertyNames: function (parent) {
                return this.keys(parent, function (obj, key) { return true; });
            },

            run: function () {
                var result;
                if (util.hasOwnProp.call(this.stm, 'transactionFrame') &&
                    this.parent !== this.stm.transactionFrame &&
                    this !== this.stm.transactionFrame) {
                    throw "Internal Failure";
                }
                this.funIndex = 0;
                this.stm.transactionFrame = this;
                while (true) {
                    try {
                        return this.commit(this.funs[this.funIndex]());
                    } catch (err) {
                        if (err === this.retryException) {
                            if (0 === this.funIndex) {
                                // If 0 === this.funIndex then we have
                                // done a full retry and are now
                                // waiting on the server. Thus we
                                // should continue unwinding the stack
                                // and thus rethrow if we have a
                                // parent. If we don't have a parent
                                // then we should just absorb the
                                // exception and exit the loop.

                                if (util.hasOwnProp.call(this, 'parent')) {
                                    throw err;
                                } else {
                                    return;
                                }
                            } else {
                                // If 0 !== this.funIndex then we're
                                // in an orElse and we've hit a retry
                                // which we're going to service by
                                // changing to the next alternative
                                // and going round the loop
                                // again. Thus absorb the exception,
                                // and don't exit the loop. Do a
                                // partial reset - throw out the
                                // writes but keep the reads that led
                                // us here (and keep the creates -
                                // they won't be grabbed by the server
                                // until we do a commit).
                                this.reset(false);
                            }
                        } else {
                            if (util.hasOwnProp.call(this, 'parent')) {
                                this.stm.transactionFrame = this.parent;
                            } else {
                                delete this.stm.transactionFrame;
                            }
                            throw err;
                        }
                    }
                }
            },

            commit: function (result) {
                var self, success, failure, txnLog, worklist, obj, keys, i;

                if (! util.hasOwnProp.call(this, 'parent')) {
                    self = this;
                    txnLog = this.cerealise();
                    delete this.stm.transactionFrame;

                    // All created vars are about to become
                    // public. Thus bump vsn to 1.
                    keys = Object.keys(self.created).sort();
                    for (i = 0; i < keys.length; i += 1) {
                        obj = this.created[keys[i]];
                        if (obj.version === 0) {
                            obj.version = 1;
                        }
                    }

                    success = function () {
                        var ids, names, i, j, parent, tvar, name, value;
                        ids = Object.keys(self.written).sort();
                        for (i = 0; i < ids.length; i += 1) {
                            parent = self.written[ids[i]];
                            tvar = parent.tvar;
                            tvar.version += 1;
                            self.log("incr " + tvar.id + " to " + tvar.version);
                            names = Object.keys(parent.children);
                            for (j = 0; j < names.length; j += 1) {
                                name = names[j];
                                value = parent.children[name];
                                if (self.deleted === value) {
                                    self.log(["Committing delete to ", ids[i], ".", name]);
                                    delete tvar.raw[name];
                                } else {
                                    self.log(["Committing write to ", ids[i], ".", name]);
                                    // mess for dealing with arrays, defineProperty, and some proxy mess
                                    if (tvar.isArray && 'length' == name) {
                                        tvar.raw[name] = value.value;
                                    } else {
                                        Object.defineProperty(tvar.raw, name, value);
                                    }
                                }
                            }
                        }

                        if (util.hasOwnProp.call(self, 'cont')) {
                            return self.cont(result);
                        } else {
                            return result;
                        }
                    };

                    failure = function () {
                        // As we're in commit, created vars will be
                        // grabbed even on a failed commit. Thus do a
                        // full reset here.
                        self.reset(true);
                        return self.run();
                    };

                    txnLog.type = "commit";

                    return this.stm.server.commit(txnLog, success, failure);

                } else {
                    // TODO - we could do a validation here - not a
                    // full commit. Would require server support.

                    if (util.hasOwnProp.call(this, 'parent')) {
                        this.stm.transactionFrame = this.parent;
                    } else {
                        delete this.stm.transactionFrame;
                    }

                    worklist = [this.read].concat(this.readStack);
                    while (worklist.length !== 0) {
                        obj = worklist.shift();
                        keys = Object.keys(obj);
                        for (i = 0; i < keys.length; i += 1) {
                            this.parent.read[keys[i]] = obj[keys[i]];
                        }
                    }

                    keys = Object.keys(this.created);
                    for (i = 0; i < keys.length; i += 1) {
                        this.parent.created[keys[i]] = this.created[keys[i]];
                    }

                    keys = Object.keys(this.written);
                    for (i = 0; i < keys.length; i += 1) {
                        this.parent.written[keys[i]] = this.written[keys[i]];
                    }

                    if (util.hasOwnProp.call(this, 'cont')) {
                        return this.cont(result);
                    } else {
                        return result;
                    }
                }
            },

            retry: function () {
                var self, restart, txnLog;

                this.funIndex += 1;
                if (this.funIndex === this.funs.length) {
                    this.funIndex = 0;
                }

                if (0 === this.funIndex) {
                    self = this;
                    txnLog = this.cerealise({read: true});
                    delete this.stm.transactionFrame;

                    restart = function () {
                        // In a retry, we only send up the reads, not
                        // createds. So don't reset the createds.
                        self.reset(false);
                        return self.run();
                    };

                    txnLog.type = "retry";

                    this.stm.server.retry(txnLog, restart);
                }

                throw this.retryException;
            },

            cerealise: function (obj) {
                var worklist, seen, keys, i, self, parent, names, j, value, desc;
                self = this;

                if (undefined === obj) {
                    obj = {read: {},
                           created: {},
                           written: {},
                           txnId: this.id};
                } else {
                    obj.txnId = this.id;
                }

                if (util.hasOwnProp.call(obj, 'created') && obj.created) {
                    obj.created = {};
                    keys = Object.keys(this.created).sort();
                    for (i = 0; i < keys.length; i += 1) {
                        obj.created[keys[i]] = {value: this.created[keys[i]].raw,
                                                isArray: this.created[keys[i]].isArray,
                                                version: this.created[keys[i]].version};
                    }
                }

                if (util.hasOwnProp.call(obj, 'read') && obj.read) {
                    obj.read = {};
                    seen = {};
                    worklist = [this.read].concat(this.readStack);
                    while (worklist.length !== 0) {
                        value = worklist.shift();
                        keys = Object.keys(value).sort();
                        for (i = 0; i < keys.length; i += 1) {
                            if (! util.hasOwnProp.call(seen, keys[i])) {
                                seen[keys[i]] = true;
                                if (util.hasOwnProp.call(obj, 'created') ||
                                    ! util.hasOwnProp.call(this.created, keys[i])) {
                                    obj.read[keys[i]] = {version: this.read[keys[i]]};
                                }
                            }
                        }
                    }
                }

                if (util.hasOwnProp.call(obj, 'written') && obj.written) {
                    obj.written = {};
                    keys = Object.keys(this.written).sort();
                    for (i = 0; i < keys.length; i += 1) {
                        parent = {children: {},
                                  version: this.written[keys[i]].tvar.version};
                        obj.written[keys[i]] = parent;
                        names = Object.keys(this.written[keys[i]].children);
                        for (j = 0; j < names.length; j += 1) {
                            value = this.written[keys[i]].children[names[j]];
                            if (this.deleted === value) {
                                parent.children[names[j]] = {deleted: true};
                            } else if (util.isPrimitive(value.value)) {
                                parent.children[names[j]] = value;
                            } else {
                                desc = {};
                                util.shallowCopy(value, desc);
                                delete desc.value;
                                desc.tvar = this.stm.asTVar(value.value).id;
                                parent.children[names[j]] = desc;
                            }
                        }
                    }
                }

                return obj;
            }
        };


        STM = function () {
            this.tVarCount = 0;
            this.txnCount = 0;

            this.objToTVar = new Cereal.Map();
            this.proxiedToTVar = new Cereal.Map();
            this.idToTVar = {};
            this.retryException = {};
            this.server.stm = this;
            this.root();
        };

        STM.prototype = {
            logging: false,

            log: function (msgs) {
                var str;
                if (this.logging) {
                    if (typeof msgs === "string") {
                        console.log(msgs);
                    } else if (undefined === msgs.join) {
                        console.log(msgs);
                    } else {
                        console.log(msgs.join(""));
                    }
                }
            },

            server: {
                commit: function (txnLog, success, failure) {
                    this.stm.log("Committing txn log:");
                    this.stm.log(txnLog);
                    return success();
                },

                retry: function (txnLog, restart) {
                    // default implementation is just going to spin on
                    // this for the time being.
                    this.stm.log("Retry with txn log:");
                    this.stm.log(txnLog);
                    return restart();
                }
            },

            inTransaction: function () {
                return util.hasOwnProp.call(this, 'transactionFrame');
            },

            orElse: function (funs, cont, parent) {
                var txn;
                if (undefined === parent) {
                    parent = this.transactionFrame;
                }
                this.txnCount += 1;
                txn = new Transaction(this, this.txnCount, parent, funs, cont);
                return txn.run();
            },

            atomically: function (fun, cont) {
                return this.orElse([fun], cont);
            },

            retry: function () {
                if (!this.inTransaction()) {
                    throw new RetryOutsideTransactionException();
                }
                this.transactionFrame.retry();
            },

            recordRead: function (parent) {
                if (this.inTransaction()) {
                    this.transactionFrame.recordRead(parent);
                }
            },

            recordCreation: function (value) {
                if (this.inTransaction()) {
                    this.transactionFrame.recordCreation(value);
                } else {
                    var self = this;
                    self.atomically(function () {
                        self.transactionFrame.recordCreation(value);
                    });
                }
            },

            isProxied: function (obj) {
                return this.proxiedToTVar.has(obj);
            },

            asTVar: function (proxied) {
                return this.proxiedToTVar.get(proxied);
            },

            // always returns a TVar; not a proxied obj
            ensureTVar: function (obj) {
                var val, parentId;
                if (undefined === obj || util.isPrimitive(obj)) {
                    return {proxied: obj, raw: obj};
                }
                val = this.proxiedToTVar.get(obj);
                if (undefined === val) {
                    val = this.objToTVar.get(obj);
                    if (undefined === val) {
                        this.tVarCount += 1;
                        val = new TVar(this.tVarCount, obj, this);
                        this.proxiedToTVar.set(val.proxied, val);
                        this.objToTVar.set(obj, val);
                        this.idToTVar[val.id] = val;
                        this.recordCreation(val);
                        return val;
                    } else {
                        // found it in the cache
                        return val;
                    }
                } else {
                    // obj was already proxied
                    return val;
                }
            },

            lift: function (obj) {
                return this.ensureTVar(obj).proxied;
            },

            watch: function () {
                var self = this,
                    cont = arguments[0],
                    objs = Array.prototype.slice.call(arguments, 1),
                    fun, i;
                for (i = 0; i < objs.length; i += 1) {
                    objs[i] = self.lift(objs[i]);
                }
                fun = function (copies) {
                    var i, j, obj, keys, seen, delta, prev, field, deltas, copies2, retry;
                    self.atomically(
                        function () {
                            deltas = new Cereal.Map();
                            copies2 = new Cereal.Map();
                            retry = true;
                            for (i = 0; i < objs.length; i += 1) {
                                obj = objs[i];
                                copies2.set(obj, TVar.prototype.clone(obj));
                                delta = { added:    [],
                                          modified: [],
                                          deleted:  [] };
                                if (undefined === copies) {
                                    delta.added = Object.keys(obj);
                                    // first time through, existence
                                    // of empty obj should be enough
                                    // to trigger
                                    retry = false;
                                    deltas.set(obj, delta);
                                } else {
                                    prev = copies.get(obj);
                                    seen = {};
                                    keys = Object.keys(obj).concat(Object.keys(prev));
                                    for (j = 0; j < keys.length; j += 1) {
                                        field = keys[j];
                                        if (util.hasOwnProp.call(seen, field)) {
                                            continue;
                                        }
                                        seen[field] = true;
                                        if (util.hasOwnProp.call(obj, field) &&
                                            util.hasOwnProp.call(prev, field)) {
                                            if (obj[field] !== prev[field]) {
                                                delta.modified.push(field);
                                            }
                                        } else if (util.hasOwnProp.call(obj, keys[j])) {
                                            delta.added.push(field);
                                        } else {
                                            delta.deleted.push(field);
                                        }
                                    }
                                    if ((delta.added.length + delta.modified.length +
                                         delta.deleted.length) > 0) {
                                        deltas.set(obj, delta);
                                        retry = false;
                                    }
                                }
                            }

                            if (retry) {
                                self.retry();
                            } else {
                                return {copies: copies2, result: cont(true, deltas)};
                            }
                        }, function (result) {
                            if (cont(false, result.result)) {
                                fun(result.copies);
                            }
                        });
                };
                fun(undefined);
            },

            access: function (obj, field) {
                var tvar, result, func;
                tvar = this.asTVar(obj);
                if (undefined === tvar) {
                    result = obj[field];
                } else {
                    result = tvar.handler.get(tvar.proxied, field);
                }
                if (undefined !== result && null !== result && Function === result.constructor) {
                    func = function () {
                        var args = arguments;
                        return result.apply(obj, args);
                    };
                    func.apply = function (thisObj, argsArray) {
                        return result.apply(thisObj, args);
                    };
                    func.call = function () {
                        // disgusting hack to push arguments into a real array.
                        var args = Array.prototype.slice.call(arguments, 0);
                        return result.apply(args[0], args.slice(1));
                    };
                    return func;
                } else {
                    return result;
                }
            },

            assign: function (obj, field, value) {
                var tvar = this.asTVar(obj);
                if (undefined === tvar) {
                    return obj[field] = value;
                } else {
                    return tvar.handler.set(tvar.proxied, field, value);
                }
            },

            enumerate: function (obj) {
                var tvar = this.asTVar(obj);
                if (undefined === tvar) {
                    return obj;
                } else {
                    return tvar.handler.enumerate();
                }
            },

            has: function (obj, field) {
                var tvar = this.asTVar(obj);
                if (undefined === tvar) {
                    return field in obj;
                } else {
                    return tvar.handler.has(field);
                }
            },

            erase: function (obj, field) {
                var tvar = this.asTVar(obj);
                if (undefined === tvar) {
                    return delete obj[field];
                } else {
                    // IE can't cope if you write ...handler.delete(...
                    return tvar.handler['delete'](field);
                }
            },

            root: function () {
                var obj, val;
                if (0 === this.tVarCount) {
                    obj = {};
                    this.tVarCount += 1;
                    val = new TVar(this.tVarCount, obj, this);
                    this.proxiedToTVar.set(val.proxied, val);
                    this.objToTVar.set(obj, val);
                    this.idToTVar[val.id] = val;
                    val.version = 1;
                    return val.proxied;
                } else {
                    return this.idToTVar[1].proxied;
                }
            },

            applyUpdates: function (updates) {
                var keys, names, update, tvar, i, j, value, obj;
                keys = Object.keys(updates);
                for (i = 0; i < keys.length; i += 1) {
                    update = updates[keys[i]];
                    tvar = this.idToTVar[keys[i]];
                    if (undefined === tvar) {
                        if (update.isArray) {
                            obj = [];
                        } else {
                            obj = {};
                        }
                        tvar = new TVar(keys[i], obj, this);
                        this.proxiedToTVar.set(tvar.proxied, tvar);
                        this.objToTVar.set(obj, tvar);
                        this.idToTVar[tvar.id] = tvar;
                    }

                    // It's possible to see an update for a var with
                    // the same version as we already have due to
                    // multiple txns being rejected for the same
                    // reason (or a retry and commit from the same
                    // client - the commit may alter the var the retry
                    // is watching and thus prompt an update after the
                    // commit completes). If the versions are equal,
                    // then just ignore it.

                    if (tvar.version > update.version) {
                        console.error("Invalid update detected: " + tvar.id +
                                      " local vsn: " + tvar.version + "; remote vsn: " + update.version);
                    }
                    if (tvar.version === update.version) {
                        continue;
                    }

                    tvar.version = update.version;

                    names = Object.keys(tvar.raw);
                    for (j = 0; j < names.length; j += 1) {
                        if ("_map" !== names[j] && ! util.hasOwnProp.call(update.value, names[j])) {
                            delete tvar.raw[names[j]];
                        }
                    }

                    names = Object.keys(update.value);
                    for (j = 0; j < names.length; j += 1) {
                        this.applyUpdate(tvar, names[j], update.value[names[j]], updates);
                    }
                }
            },

            applyUpdate: function (tvar, name, desc, updates) {
                var obj, tvar2;
                if (! util.hasOwnProp.call(desc, 'tvar')) {
                    if (tvar.isArray && 'length' === name) {
                        tvar.raw[name] = desc.value;
                    } else {
                        Object.defineProperty(tvar.raw, name, desc);
                    }
                } else {
                    if (undefined === this.idToTVar[desc.tvar]) {
                        if (util.hasOwnProp.call(updates, desc.tvar)) {
                            // we're going to create a new empty var
                            // so that we can proceed here.
                            if (updates[desc.tvar].isArray) {
                                obj = [];
                            } else {
                                obj = {};
                            }
                            tvar2 = new TVar(desc.tvar, obj, this);
                            this.proxiedToTVar.set(tvar2.proxied, tvar2);
                            this.objToTVar.set(obj, tvar2);
                            this.idToTVar[tvar2.id] = tvar2;
                        } else {
                            // not known already, and not defined by updates!
                            throw new InternalException();
                        }
                    }
                    desc.value = this.idToTVar[desc.tvar].proxied;
                    delete desc.tvar;
                    Object.defineProperty(tvar.raw, name, desc);
                }
            }
        };

    }());

    (function () {
        var p, compatNeeded = false;
        p = {
            logging: function (bool) {
                this.stm.logging = bool;
            },

            inTransaction: function () {
                return this.stm.inTransaction();
            },

            orElse: function (alternatives, continuation) {
                return this.stm.orElse(alternatives, continuation);
            },

            atomically: function (fun, continuation) {
                return this.stm.atomically(fun, continuation);
            },

            retry: function () {
                return this.stm.retry();
            },

            lift: function (value) {
                return this.stm.lift(value);
            },

            access: function (obj, field) {
                return this.stm.access(obj, field);
            },

            assign: function (obj, field, value) {
                return this.stm.assign(obj, field, value);
            },

            enumerate: function (obj) {
                return this.stm.enumerate(obj);
            },

            has: function (obj, field) {
                return this.stm.has(obj, field);
            },

            erase: function (obj, field) {
                return this.stm.erase(obj, field);
            },

            watch: function () {
                var args = arguments;
                return this.stm.watch.apply(this.stm, args);
            },

            onPreAuthenticated: function (message, sockjs) {
                return true;
            },

            onAuthenticated: function () {
            },

            connect: function () {
            }
        };

        if (typeof exports !== "undefined") {
            // we're in node

            if ("undefined" === typeof Proxy) {
                compatNeeded = true;
            }

            Atomize = function (ClientCtor, serverEventEmitter) {
                var FakeConn,
                    inflight = {},
                    self = this;

                this.stm = new STM();

                if (compatNeeded) {
                    require('./compat').compat.load(this.stm);
                }

                FakeConn = function () {
                    this.id = "server";
                    this.emitter = new events.EventEmitter();
                    util.lift(this.emitter, this,
                              ['on', 'once', 'removeListener', 'removeAllListeners', 'emit']);
                };
                FakeConn.prototype = {
                    write: function (msg) {
                        // this is the server writing a message back
                        // to the client.

                        var txnLog, txnId, txn;
                        txnLog = Cereal.parse(msg);
                        switch (txnLog.type) {
                        case "commit":
                            txnId = txnLog.txnId;
                            txn = inflight[txnId];
                            delete inflight[txnId];
                            if (txnLog.result === "success") {
                                txn.success();
                            } else {
                                txn.failure();
                            }
                            break;
                        case "retry":
                            txnId = txnLog.txnId;
                            txn = inflight[txnId];
                            delete inflight[txnId];
                            txn.restart();
                            break;
                        case "updates":
                            self.stm.log("Received Updates:");
                            self.stm.log(txnLog);
                            self.stm.applyUpdates(txnLog.updates);
                            break;
                        default:
                            self.stm.log("Confused");
                        }
                    }
                };

                self.client = new ClientCtor(new FakeConn(), serverEventEmitter);

                self.stm.server.commit = function (txnLog, success, failure) {
                    var obj;
                    obj = {txnLog: txnLog, success: success, failure: failure};
                    self.stm.log(["[Txn ", txnLog.txnId, "] sending commit"]);
                    self.stm.log(txnLog);
                    inflight[txnLog.txnId] = obj;
                    self.client.dispatch(Cereal.stringify(txnLog));
                };

                self.stm.server.retry = function (txnLog, restart) {
                    var obj;
                    obj = {txnLog: txnLog, restart: restart};
                    self.stm.log(["[Txn ", txnLog.txnId, "] sending retry"]);
                    self.stm.log(txnLog);
                    inflight[txnLog.txnId] = obj;
                    self.client.dispatch(Cereal.stringify(txnLog));
                };

                this.root = this.stm.root();
            };

            exports.Atomize = Atomize;

        } else {
            (function () {
                if ("undefined" === typeof Proxy) {
                    var scripts = document.getElementsByTagName('script'),
                        index = scripts.length - 1,
                        myScript = scripts[index],
                        script = document.createElement('script');

                    script.src = myScript.src.substring(0, 1 + (myScript.src.lastIndexOf('/'))) + "compat.js";

                    document.getElementsByTagName('head')[0].appendChild(script);

                    compatNeeded = true;
                }
            }());

            if (undefined === window.SockJS) {
                console.warn("SockJS not found. Assuming offline-mode.");

                Atomize = function () {
                    this.stm = new STM();
                    this.root = this.stm.root();

                    if (compatNeeded) {
                        AtomizeCompat.load(this.stm);
                    }

                    this.connect = function () {
                        this.onAuthenticated();
                    };
                };

            } else {

                Atomize = function (url) {
                    var self = this,
                        commit_inflight = {},
                        commit_queue = [],
                        retry_inflight = {},
                        retry_queue = [];

                    this.stm = new STM();

                    if (compatNeeded) {
                        AtomizeCompat.load(this.stm);
                    }

                    this.url = url;
                    if (undefined === this.url) {
                        console.warn("No url provided. Assuming offline-mode.");
                    } else {
                        this.ready = false;

                        this.connect = function () {
                            self.sockjs = new SockJS(self.url);

                            self.sockjs.onopen = function () {
                                var i, obj;
                                self.stm.log(["Connected to server ", self.url, " (using ", self.sockjs.protocol, ")"]);
                                self.ready = self.onPreAuthenticated(undefined, self.sockjs);
                                if (self.ready) {
                                    self.onAuthenticated();
                                } else {
                                    return;
                                }
                                for (i = 0; i < commit_queue.length; i += 1) {
                                    obj = commit_queue[i];
                                    self.stm.server.commit(obj.txnLog, obj.success, obj.failure);
                                }
                                commit_queue = [];
                                for (i = 0; i < retry_queue.length; i += 1) {
                                    obj = retry_queue[i];
                                    self.stm.server.retry(obj.txnLog, obj.onchange);
                                }
                                retry_queue = [];
                            };

                            self.sockjs.onclose = function (e) {
                                var keys, i, obj;
                                self.stm.log(["Disconnected from server ", self.url, " (", e.status, " ", e.reason, ")"]);
                                self.ready = false;
                                keys = Object.keys(commit_inflight).sort();
                                for (i = 0; i < keys.length; i += 1) {
                                    commit_queue.push(commit_inflight[keys[i]]);
                                }
                                commit_inflight = {};
                                keys = Object.keys(retry_inflight).sort();
                                for (i = 0; i < keys.length; i += 1) {
                                    retry_queue.push(retry_inflight[keys[i]]);
                                }
                                retry_inflight = {};
                            };

                            self.sockjs.onmessage = function (e) {
                                var txnLog, txnId, txn;
                                if (!self.ready) {
                                    self.ready = self.onPreAuthenticated(e, self.sockjs);
                                    if (self.ready) {
                                        self.onAuthenticated();
                                    }
                                    return; // authentication consumed e, so return here
                                }
                                txnLog = Cereal.parse(e.data);
                                switch (txnLog.type) {
                                case "commit":
                                    txnId = txnLog.txnId;
                                    txn = commit_inflight[txnId];
                                    delete commit_inflight[txnId];
                                    self.stm.log(["[Txn ", txnId, "] commit response received: ", txnLog.result]);
                                    if (txnLog.result === "success") {
                                        txn.success();
                                    } else {
                                        txn.failure();
                                    }
                                    break;
                                case "retry":
                                    txnId = txnLog.txnId;
                                    txn = retry_inflight[txnId];
                                    delete retry_inflight[txnId];
                                    self.stm.log(["[Txn ", txnId, "] retry response received."]);
                                    txn.restart();
                                    break;
                                case "updates":
                                    self.stm.log("Received Updates:");
                                    self.stm.log(txnLog);
                                    self.stm.applyUpdates(txnLog.updates);
                                    break;
                                default:
                                    self.stm.log("Received unexpected message from server:");
                                    self.stm.log(txnLog);
                                }
                            };
                        };

                        self.stm.server.commit = function (txnLog, success, failure) {
                            var obj;
                            obj = {txnLog: txnLog, success: success, failure: failure};
                            if (! self.ready) {
                                commit_queue.push(obj);
                                return;
                            }
                            self.stm.log(["[Txn ", txnLog.txnId, "] sending commit"]);
                            self.stm.log(txnLog);
                            commit_inflight[txnLog.txnId] = obj;
                            self.sockjs.send(Cereal.stringify(txnLog));
                        };

                        self.stm.server.retry = function (txnLog, restart) {
                            var obj;
                            obj = {txnLog: txnLog, restart: restart};
                            if (! self.ready) {
                                retry_queue.push(obj);
                                return;
                            }
                            self.stm.log(["[Txn ", txnLog.txnId, "] sending retry"]);
                            self.stm.log(txnLog);
                            retry_inflight[txnLog.txnId] = obj;
                            self.sockjs.send(Cereal.stringify(txnLog));
                        };
                    }

                    this.root = this.stm.root();
                };
            }
        }

        Atomize.prototype = p;

    }());

}(this));
