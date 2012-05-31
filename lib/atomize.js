/*global WeakMap, Map, Proxy, SockJS, Cereal, exports, require */
/*jslint browser: true, devel: true */

var Atomize;

function NotATVarException() {}
NotATVarException.prototype = {
    prototype: Error.prototype,
    constructor: NotATVarException,
    toString: function () {return "Not A TVar";}
};

function WriteOutsideTransactionException() {}
WriteOutsideTransactionException.prototype = {
    prototype: Error.prototype,
    constructor: WriteOutsideTransactionException,
    toString: function () {return "Write outside transaction";}
};

function DeleteOutsideTransactionException() {}
DeleteOutsideTransactionException.prototype = {
    prototype: Error.prototype,
    constructor: DeleteOutsideTransactionException,
    toString: function () {return "Delete outside transaction";}
};

function RetryOutsideTransactionException() {}
RetryOutsideTransactionException.prototype = {
    prototype: Error.prototype,
    constructor: RetryOutsideTransactionException,
    toString: function () {return "Retry outside transaction";}
};

function InternalException() {}
InternalException.prototype = {
    prototype: Error.prototype,
    constructor: InternalException,
    toString: function () {return "Internal Exception";}
};

function UnpopulatedException(tvar) { this.tvar = tvar; }
UnpopulatedException.prototype = {
    prototype: Error.prototype,
    constructor: UnpopulatedException,
    toString: function () {return "Use of unpopulated tvar: " + this.tvar.id;}
};

function AccessorDescriptorsNotSupportedException(desc) { this.desc = desc; }
AccessorDescriptorsNotSupportedException.prototype = {
    prototype: Error.prototype,
    constructor: AccessorDescriptorsNotSupportedException,
    toString: function () {
        return "Accessor Descriptors Not Supported: " +
            JSON.stringify(this.desc);
    }
};

function InvalidDescriptorException(desc) { this.desc = desc; }
InvalidDescriptorException.prototype = {
    prototype: Error.prototype,
    constructor: InvalidDescriptorException,
    toString: function () {
        return "Invalid Descriptor: " + JSON.stringify(this.desc);
    }
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
            unpopulated: false,

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
                var self, stm, handler;

                self = this;
                stm = self.stm;

                handler = {

                    getOwnPropertyDescriptor: function (name) {
                        self.log(["getOwnPropertyDescriptor: ", name]);
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        var desc, value;
                        if ("_map" === name || ! stm.inTransaction()) {
                            desc = Object.getOwnPropertyDescriptor(self.raw, name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return undefined;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                desc = Object.getOwnPropertyDescriptor(self.raw, name);
                                if (undefined !== desc &&
                                    ! (undefined === desc.value ||
                                       util.isPrimitive(desc.value) ||
                                       'function' === typeof desc.value)) {
                                    value = stm.ensureTVar(desc.value).proxied;
                                    if (desc.value !== value) {
                                        // rewrite our local graph to use the proxied version
                                        self.log("Implicity lifting");
                                        desc.value = value;
                                        stm.transactionFrame.recordDefine(self, name, desc);
                                    }
                                }
                            }
                        }
                        if (undefined !== desc &&
                            util.hasOwnProp.call(desc, 'configurable')) {
                            desc.configurable = true; // should go away with direct proxies
                        }
                        return desc;
                    },

                    getPropertyDescriptor: function (name) {
                        self.log(["getPropertyDescriptor: ", name]);
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        var visited = [], tvar = self, obj = tvar.proxied, desc;
                        while (obj !== undefined && obj !== null && -1 === visited.indexOf(obj)) {
                            tvar = stm.ensureTVar(obj);
                            obj = tvar.proxied;
                            desc = tvar.handler.getOwnPropertyDescriptor(name);
                            if (undefined === desc) {
                                visited.push(obj);
                                obj = Object.getPrototypeOf(obj);
                            } else {
                                return desc;
                            }
                        }
                        return undefined;
                    },

                    getOwnPropertyNames: function () {
                        self.log("getOwnPropertyNames");
                        stm.recordRead(self);
                        var names, result, i;
                        if (stm.inTransaction()) {
                            result = {};
                            // names here won't contain any names that have been deleted...
                            names = stm.transactionFrame.getOwnPropertyNames(self);
                            for (i = 0; i < names.length; i += 1) {
                                result[names[i]] = true;
                            }
                            // ...but here, these names may have been deleted in the txn.
                            names = Object.getOwnPropertyNames(self.raw);
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
                        var seen = {}, visited = [], tvar = self, obj = tvar.proxied, names, i;
                        // the final Object.prototype !== obj is probably a bug in chrome/v8:
                        // http://code.google.com/p/v8/issues/detail?id=2145
                        while (obj !== undefined && obj !== null
                               && -1 === visited.indexOf(obj) && Object.prototype !== obj) {
                            tvar = stm.ensureTVar(obj);
                            obj = tvar.proxied;
                            names = tvar.handler.getOwnPropertyNames();
                            for (i = 0; i < names.length; i += 1) {
                                if (! util.hasOwnProp.call(seen, names[i])) {
                                    seen[names[i]] = true;
                                }
                            }
                            visited.push(obj);
                            obj = Object.getPrototypeOf(obj);
                        }
                        return Object.keys(seen);
                    },

                    defineProperty: function (name, desc) {
                        self.log(["defineProperty: ", name]);
                        if ("_map" === name) {
                            return Object.defineProperty(self.raw, name, desc);
                        }
                        if (stm.inTransaction()) {
                            if (util.hasOwnProp.call(desc, 'value')) {
                                if (util.isPrimitive(desc.value) ||
                                    stm.isProxied(desc.value)) {
                                    stm.transactionFrame.recordDefine(self, name, desc);
                                    return self.proxied;
                                } else {
                                    // the value is not a tvar, explode
                                    throw new NotATVarException(desc.value);
                                }
                            } else {
                                if (util.hasOwnProp.call(desc, 'get') ||
                                    util.hasOwnProp.call(desc, 'set')) {
                                    throw new AccessorDescriptorsNotSupportedException(desc);
                                } else {
                                    throw new InvalidDescriptorException(desc);
                                }
                            }
                        } else {
                            throw new WriteOutsideTransactionException();
                        }
                    },

                    erase: function (name) {
                        self.log(["delete: ", name]);
                        var desc;
                        if ("_map" === name) {
                            return delete self.raw[name];
                        } else if (stm.inTransaction()) {
                            desc = handler.getOwnPropertyDescriptor(name);
                            if (undefined === desc || desc.configurable) {
                                // Just like in set: we don't do the delete here
                                stm.transactionFrame.recordDelete(self, name);
                                return true;
                            } else {
                                return false;
                            }
                        } else {
                            throw new DeleteOutsideTransactionException();
                        }
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
                            return !!handler.getPropertyDescriptor(name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return false;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                return !!handler.getPropertyDescriptor(name);
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
                            return !!handler.getOwnPropertyDescriptor(name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return false;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                return !!handler.getOwnPropertyDescriptor(name);
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
                        if ("_map" === name || ! stm.inTransaction()) {
                            return self.raw[name];
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            self.log("...has been deleted");
                            return undefined;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                desc = handler.getPropertyDescriptor(name);
                                if (undefined === desc) {
                                    self.log("...not found");
                                    return undefined;
                                } else if ('value' in desc) {
                                    result = desc.value;
                                    if (undefined === result || util.isPrimitive(result)) {
                                        self.log("...found and not object");
                                        return result;
                                    }
                                    if ('function' === typeof result) {
                                        self.log("...found and is a function");
                                        return result;
                                    }
                                    return result;
                                } else if ('get' in desc && undefined !== desc.get) {
                                    return desc.get.call(self.proxied);
                                } else {
                                    return undefined;
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
                        var result = [], keys, i, name, desc;
                        stm.recordRead(self);
                        keys = handler.getPropertyNames();
                        for (i = 0; i < keys.length; i += 1) {
                            name = keys[i];
                            desc = handler.getPropertyDescriptor(name);
                            if (undefined !== desc && desc.enumerable) {
                                result.push(name);
                            }
                        }
                        return result;
                    },

                    keys: function () {
                        self.log("keys");
                        var result = [], keys, i, name, desc;
                        stm.recordRead(self);
                        keys = handler.getOwnPropertyNames();
                        for (i = 0; i < keys.length; i += 1) {
                            name = keys[i];
                            desc = handler.getOwnPropertyDescriptor(name);
                            if (undefined !== desc && desc.enumerable) {
                                result.push(name);
                            }
                        }
                        return result;
                    }
                };

                // disgusting hack to get around fact IE won't parse
                // JS if it sees 'delete' as a field.
                handler['delete'] = handler['erase'];

                return handler;
            }
        };


        function Transaction(stm, id, parent, funs, cont, abort) {
            this.stm = stm;
            this.id = id;
            this.funs = funs;
            this.funIndex = 0;
            if (undefined !== cont && undefined !== cont.call) {
                this.cont = cont;
            }
            if (undefined !== abort && undefined !== abort.call) {
                this.abort = abort;
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
            retryException: {
                toString: function () { return "Internal Retry Exception"; }
            },
            deleted: {
                toString: function () { return "Deleted Object"; }
            },

            log: function (msgs) {
                if (typeof msgs === "string") {
                    this.stm.log(["[Txn ", this.id, "] ", msgs]);
                } else {
                    this.stm.log(["[Txn ", this.id, "] "].concat(msgs));
                }
            },

            reset: function (createds) {
                if (0 === this.funIndex) {
                    this.readStack = [];
                } else if (Object.keys(this.read).length !== 0) {
                    this.readStack.push(this.read);
                }
                this.read = {};
                this.written = {};
                if (createds) {
                    this.created = {};
                }
            },

            recordRead: function (parent) {
                this.read[parent.id] = parent.version;
                if (parent.unpopulated) {
                    throw new UnpopulatedException(parent);
                }
            },

            recordCreation: function (value, meta) {
                this.created[value.id] = {value: value,
                                          meta: meta};
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
                if (this.deleted !== descriptor &&
                    ! util.hasOwnProp.call(descriptor, 'value')) {
                    if (util.hasOwnProp.call(descriptor, 'get') ||
                        util.hasOwnProp.call(descriptor, 'set')) {
                        throw new AccessorDescriptorsNotSupportedException(descriptor);
                    } else {
                        throw new InvalidDescriptorException(descriptor);
                    }
                }
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
                        return obj[key].enumerable;
                    };
                }

                obj = this;
                while (undefined !== obj) {
                    if (util.hasOwnProp.call(obj.written, parent.id)) {
                        worklist.push(obj.written[parent.id].children);
                    }
                    obj = obj.parent;
                }
                // use shift not pop to ensure we start at the child
                // txn. Thus child txn 'delete' prevents parent
                // 'write' of same var from showing up, as 'seen' will
                // record the former and filter out the latter.
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
                    throw new InternalException();
                }
                this.funIndex = 0;
                this.stm.transactionFrame = this;
                while (true) {
                    try {
                        try {
                            return this.commit(this.funs[this.funIndex]());
                        } catch (err) {
                            if ((! util.isPrimitive(err)) &&
                                (UnpopulatedException.prototype ===
                                 Object.getPrototypeOf(err))) {
                                // if we're in an orElse, we need to
                                // pretend that we hit a retry in
                                // every branch, so that we actually
                                // do the server-side retry
                                this.funIndex = this.funs.length - 1;
                                this.retry();
                            } else {
                                throw err;
                            }
                        }
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
                                // until we talk to the server).
                                this.reset(false);
                            }
                        } else {
                            if (util.hasOwnProp.call(this, 'parent')) {
                                this.stm.transactionFrame = this.parent;
                            } else {
                                delete this.stm.transactionFrame;
                            }
                            err.txnFuns = this.funs;
                            throw err;
                        }
                    }
                }
            },

            bumpCreated: function () {
                var keys = Object.keys(this.created).sort(),
                    i, obj;
                for (i = 0; i < keys.length; i += 1) {
                    obj = this.created[keys[i]].value;
                    if (obj.version === 0) {
                        obj.version = 1;
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
                    this.bumpCreated();

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
                        // Created vars will be grabbed even on a
                        // failed commit. Thus do a full reset here.
                        self.reset(true);
                        return self.run();
                    };

                    txnLog.type = "commit";

                    return this.stm.server.commit(txnLog, success, failure, this.abort);

                } else {
                    // TODO - we could do a validation here - not a
                    // full commit. Would require server support.

                    this.stm.transactionFrame = this.parent;

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
                    txnLog = this.cerealise({created: true, read: true});
                    delete this.stm.transactionFrame;

                    // All created vars are about to become
                    // public. Thus bump vsn to 1.
                    this.bumpCreated();

                    restart = function () {
                        // Created vars will be grabbed even on a
                        // retry. Thus even if we have to restart
                        // here, we don't have to worry about the
                        // current createds any more.
                        self.reset(true);
                        return self.run();
                    };

                    txnLog.type = "retry";

                    this.stm.server.retry(txnLog, restart, this.abort);
                }

                throw this.retryException;
            },

            cerealise: function (obj) {
                var worklist, seen, keys, i, self, key, meta, parent, names, j, value, desc;
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
                        key = keys[i];
                        obj.created[key] = {value: this.created[key].value.raw,
                                            isArray: this.created[key].value.isArray,
                                            version: this.created[key].value.version};
                        meta = this.created[key].meta;
                        if (undefined !== meta) {
                            obj.created[key].meta = meta;
                        }
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
                            key = keys[i];
                            if (! util.hasOwnProp.call(seen, key)) {
                                seen[key] = true;
                                if (util.hasOwnProp.call(obj, 'created') ||
                                    ! util.hasOwnProp.call(this.created, key)) {
                                    obj.read[keys[i]] = {version: value[key]};
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
            this.server = this.noopServer();
            this.root();
            this.prefix = "";
        };

        STM.prototype = {
            logging: false,

            log: function (msgs) {
                var str;
                if (this.logging) {
                    if (typeof msgs === "string") {
                        console.log(this.prefix + msgs);
                    } else if (undefined === msgs.join) {
                        console.log(msgs);
                    } else {
                        console.log(this.prefix + msgs.join(""));
                    }
                }
            },

            noopServer: function () {
                var self = this;
                return {
                    commit: function (txnLog, success, failure) {
                        self.log("Committing txn log:");
                        self.log(txnLog);
                        return success();
                    },

                    retry: function (txnLog, restart) {
                        // default implementation is just going to spin on
                        // this for the time being.
                        self.log("Retry with txn log:");
                        self.log(txnLog);
                        return restart();
                    }
                };
            },

            inTransaction: function () {
                return util.hasOwnProp.call(this, 'transactionFrame');
            },

            orElse: function (funs, cont, abort) {
                var parent = this.transactionFrame,
                    txn;
                this.txnCount += 1;
                txn = new Transaction(this, this.txnCount, parent, funs, cont, abort);
                return txn.run();
            },

            atomically: function (fun, cont, abort) {
                return this.orElse([fun], cont, abort);
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

            recordCreation: function (value, meta) {
                if (this.inTransaction()) {
                    this.transactionFrame.recordCreation(value, meta);
                } else {
                    var self = this;
                    self.atomically(function () {
                        self.transactionFrame.recordCreation(value, meta);
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
            ensureTVar: function (obj, meta) {
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
                        this.recordCreation(val, meta);
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

            lift: function (obj, meta) {
                return this.ensureTVar(obj, meta).proxied;
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
                var tvar;
                tvar = this.asTVar(obj);
                if (undefined === tvar) {
                    return obj[field];
                } else {
                    return tvar.handler.get(obj, field);
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
                    val.version = 0;
                    val.unpopulated = true;
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
                    tvar.unpopulated = 0 === update.version;
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
                var obj, tvar2, desc2 = {};
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
                    util.shallowCopy(desc, desc2);
                    desc2.value = this.idToTVar[desc.tvar].proxied;
                    delete desc2.tvar;
                    Object.defineProperty(tvar.raw, name, desc2);
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

            orElse: function (alternatives, continuation, abort) {
                return this.stm.orElse(alternatives, continuation, abort);
            },

            atomically: function (fun, continuation) {
                return this.stm.atomically(fun, continuation);
            },

            retry: function () {
                return this.stm.retry();
            },

            lift: function (value, meta) {
                return this.stm.lift(value, meta);
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
            },

            close: function () {
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
                    self = this,
                    resultFuns = [];

                this.stm = new STM();

                if (compatNeeded) {
                    require('./compat').compat.load(this.stm);
                }

                function runResultFuns () {
                    while (resultFuns.length > 0) {
                        (resultFuns.pop())();
                    }
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

                        var txnLog, txnId, txn, fun;
                        txnLog = Cereal.parse(msg);
                        switch (txnLog.type) {
                        case 'result':
                            txnId = txnLog.txnId;
                            txn = inflight[txnId];
                            delete inflight[txnId];
                            self.stm.log(["[Txn ", txnId, "] response received: ", txnLog.result]);
                            fun = txn[txnLog.result];
                            if (undefined !== fun && undefined !== fun.call) {
                                if (txn.runImmediately) {
                                    runResultFuns();
                                    fun();
                                } else {
                                    resultFuns.push(fun);
                                }
                            }
                            break;
                        case 'updates':
                            self.stm.log("Received Updates:");
                            self.stm.log(txnLog);
                            runResultFuns();
                            self.stm.applyUpdates(txnLog.updates);
                            break;
                        default:
                            self.stm.log("Confused");
                        }
                    }
                };

                this.client = new ClientCtor(new FakeConn(), serverEventEmitter);

                this.stm.server = {
                    commit: function (txnLog, success, failure, abort) {
                        var serialised = Cereal.stringify(txnLog),
                            obj = {txnLog: serialised,
                                   success: success,
                                   failure: failure,
                                   abort: abort};
                        inflight[txnLog.txnId] = obj;
                        self.stm.log(["[Txn ", txnLog.txnId, "] sending commit"]);
                        self.stm.log(txnLog);
                        self.client.dispatch(serialised);
                        // set this *after* we've potentially already run it...!
                        obj.runImmediately = true;
                        runResultFuns();
                    },

                    retry: function (txnLog, restart, abort) {
                        var serialised = Cereal.stringify(txnLog),
                            obj = {txnLog: txnLog,
                                   restart: restart,
                                   abort: abort};
                        inflight[txnLog.txnId] = obj;
                        self.stm.log(["[Txn ", txnLog.txnId, "] sending retry"]);
                        self.stm.log(txnLog);
                        self.client.dispatch(serialised);
                        // set this *after* we've potentially already run it...!
                        obj.runImmediately = true;
                        runResultFuns();
                    }
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
                        inflight = {},
                        queue = [],
                        reconnector,
                        drainEnqueued;

                    this.stm = new STM();

                    if (compatNeeded) {
                        AtomizeCompat.load(this.stm);
                    }

                    this.url = url;
                    if (undefined === this.url) {
                        console.warn("No url provided. Assuming offline-mode.");
                    } else {
                        this.ready = false;

                        reconnector = {
                            initialDelay: 2000, // 2 seconds
                            maxDelay: 180000,   // 3 minutes

                            connected: function () {
                                self.stm.log("Connected");
                                reconnector.reconnect = true;
                                reconnector.delay = reconnector.initialDelay;
                            },

                            connect: function () {
                                self.stm.log("Attempting connection");
                                self.connect();
                            },

                            disconnected: function () {
                                self.stm.log("Disconnected");
                                if (reconnector.reconnect) {
                                    setTimeout(reconnector.connect, reconnector.delay);
                                    reconnector.delay += Math.floor(Math.random() * reconnector.delay);
                                    reconnector.delay = reconnector.delay > reconnector.maxDelay
                                        ? reconnector.maxDelay : reconnector.delay;
                                }
                            }
                        };

                        drainEnqueued = function () {
                            var i;
                            for (i = 0; i < queue.length; i += 1) {
                                self.sockjs.send(queue[i]);
                            }
                            queue = [];
                        };

                        this.close = function () {
                            reconnector.reconnect = false;
                            self.sockjs.close();
                        };

                        this.connect = function () {
                            reconnector.connected();
                            self.sockjs = new SockJS(self.url);

                            self.sockjs.onopen = function () {
                                self.stm.log(["Connected to server ", self.url,
                                              " (using ", self.sockjs.protocol, ")"]);
                                reconnector.connected();
                                self.ready = self.onPreAuthenticated(undefined, self.sockjs);
                                if (self.ready) {
                                    drainEnqueued();
                                    self.onAuthenticated();
                                } else {
                                    return;
                                }
                            };

                            self.sockjs.onclose = function (e) {
                                var keys, i, obj;
                                self.stm.log(["Disconnected from server ", self.url,
                                              " (", e.status, " ", e.reason, ")"]);
                                self.ready = false;
                                keys = Object.keys(inflight).sort();
                                for (i = 0; i < keys.length; i += 1) {
                                    queue.push(inflight[keys[i]].txnLog);
                                }
                                reconnector.disconnected();
                            };

                            self.sockjs.onmessage = function (e) {
                                var txnLog, txnId, txn, fun;
                                if (!self.ready) {
                                    self.ready = self.onPreAuthenticated(e, self.sockjs);
                                    if (self.ready) {
                                        drainEnqueued();
                                        self.onAuthenticated();
                                    }
                                    return; // authentication consumed e, so return here
                                }
                                txnLog = Cereal.parse(e.data);
                                switch (txnLog.type) {
                                case 'result':
                                    txnId = txnLog.txnId;
                                    txn = inflight[txnId];
                                    delete inflight[txnId];
                                    self.stm.log(["[Txn ", txnId, "] response received: ", txnLog.result]);
                                    fun = txn[txnLog.result];
                                    if (undefined !== fun && undefined !== fun.call) {
                                        fun();
                                    }
                                    break;
                                case 'updates':
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

                        this.stm.server = {
                            commit: function (txnLog, success, failure, abort) {
                                var serialised = Cereal.stringify(txnLog),
                                    obj = {txnLog: serialised,
                                           success: success,
                                           failure: failure,
                                           abort: abort};
                                inflight[txnLog.txnId] = obj;
                                if (! self.ready) {
                                    queue.push(serialised);
                                    return;
                                }
                                self.stm.log(["[Txn ", txnLog.txnId, "] sending commit"]);
                                self.stm.log(txnLog);
                                self.sockjs.send(serialised);
                            },

                            retry: function (txnLog, restart, abort) {
                                var serialised = Cereal.stringify(txnLog),
                                    obj = {txnLog: txnLog,
                                           restart: restart,
                                           abort: abort};
                                inflight[txnLog.txnId] = obj;
                                if (! self.ready) {
                                    queue.push(serialised);
                                    return;
                                }
                                self.stm.log(["[Txn ", txnLog.txnId, "] sending retry"]);
                                self.stm.log(txnLog);
                                self.sockjs.send(serialised);
                            }
                        };
                    }

                    this.root = this.stm.root();
                };
            }
        }

        Atomize.prototype = p;

    }());

}(this));
