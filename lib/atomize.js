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
        var result, i, name, names;

        result = {};
        names = ['defineProperty', 'getPropertyDescriptor',
                 'getPropertyNames', 'getOwnPropertyDescriptor',
                 'getOwnPropertyNames', 'keys', 'hasOwnProperty'];

        for (i = 0; i < names.length; i += 1) {
            name = names[i];
            if (undefined !== Object[name]) {
                if (undefined === Object[name]._origFun) {
                    result[name] = Object[name];
                } else {
                    result[name] = Object[name]._origFun;
                }
            }
        }

        result.isPrimitive = function (obj) {
            return obj !== Object(obj);
        };

        result.hasOwnProp = result.hasOwnProperty;

        result.shallowCopy = function (src, dest) {
            var keys, i;
            keys = result.keys(src);
            for (i = 0; i < keys.length; i += 1) {
                dest[keys[i]] = src[keys[i]];
            }
        };

        result.lift = function (src, dest, fields) {
            var i;
            for (i = 0; i < fields.length; i += 1) {
                dest[fields[i]] = src[fields[i]].bind(src);
            }
        };

        (function () {
            var nextId = 0, MyMap;
            if (typeof Map === "undefined") {
                if (typeof WeakMap === "undefined") {
                    MyMap = function () {
                        this.objs = {};
                        this.prims = {};
                    };
                    MyMap.prototype = {
                        id: function () {
                            nextId += 1;
                            return nextId;
                        },

                        set: function (key, value) {
                            if (result.isPrimitive(key)) {
                                this.prims[key] = value;
                            } else {
                                if (! result.hasOwnProp.call(key, '_map')) {
                                    result.defineProperty(
                                        key, '_map',
                                        {value: this.id(),
                                         writable: true,
                                         configurable: false,
                                         enumerable: false});
                                }
                                this.objs[key._map] = value;
                            }
                        },

                        get: function (key) {
                            if (result.isPrimitive(key)) {
                                return this.prims[key];
                            } else {
                                if (result.hasOwnProp.call(key, '_map')) {
                                    return this.objs[key._map];
                                } else {
                                    return undefined;
                                }
                            }
                        },

                        has: function (key) {
                            if (result.isPrimitive(key)) {
                                return result.hasOwnProp.call(this.prims, key);
                            } else {
                                return (result.hasOwnProp.call(key, '_map') &&
                                        result.hasOwnProp.call(this.objs, key._map));
                            }
                        }
                    };
                } else {
                    MyMap = WeakMap;
                }
            } else {
                MyMap = Map;
            }
            result.Map = MyMap;
        }());

        return result;
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

            log: function () {
                var args;
                if (this.stm.isLogging) {
                    args = Array.prototype.slice.call(arguments, 0);
                    args.unshift("[TVar " + this.id + "]");
                    this.stm.log.apply(this.stm, args);
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
                        self.log("getOwnPropertyDescriptor:", name);
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        var desc, value;
                        if ("_map" === name || ! stm.inTransaction()) {
                            desc = util.getOwnPropertyDescriptor(self.raw, name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return undefined;
                        } else {
                            desc = stm.transactionFrame.get(self, name);
                            if (undefined === desc) {
                                desc = util.getOwnPropertyDescriptor(self.raw, name);
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
                        self.log("getPropertyDescriptor:", name);
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        var visited = [], tvar = self, obj = tvar.proxied, desc;
                        while (obj !== undefined && obj !== null) {
                            tvar = stm.ensureTVar(obj);
                            if (-1 !== visited.lastIndexOf(tvar)) {
                                break;
                            }
                            obj = tvar.proxied;
                            desc = tvar.handler.getOwnPropertyDescriptor(name);
                            if (undefined === desc) {
                                visited.push(tvar);
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
                            names = util.getOwnPropertyNames(self.raw);
                            for (i = 0; i < names.length; i += 1) {
                                if (! stm.transactionFrame.isDeleted(self, names[i])) {
                                    result[names[i]] = true;
                                }
                            }
                            return util.keys(result);
                        } else {
                            return util.getOwnPropertyNames(self.raw);
                        }
                    },

                    getPropertyNames: function () {
                        self.log("getPropertyNames");
                        stm.recordRead(self);
                        var seen = {}, visited = [], tvar = self, obj = tvar.proxied, names, i;
                        // the final Object.prototype !== obj is probably a bug in chrome/v8:
                        // http://code.google.com/p/v8/issues/detail?id=2145
                        while (obj !== undefined && obj !== null && Object.prototype !== obj) {
                            tvar = stm.ensureTVar(obj);
                            if (-1 !== visited.lastIndexOf(tvar)) {
                                break;
                            }
                            obj = tvar.proxied;
                            names = tvar.handler.getOwnPropertyNames();
                            for (i = 0; i < names.length; i += 1) {
                                if (! util.hasOwnProp.call(seen, names[i])) {
                                    seen[names[i]] = true;
                                }
                            }
                            visited.push(tvar);
                            obj = Object.getPrototypeOf(obj);
                        }
                        return util.keys(seen);
                    },

                    defineProperty: function (name, desc) {
                        var current, match, key, merged;
                        self.log("defineProperty:", name);
                        if ("_map" === name) {
                            return util.defineProperty(self.raw, name, desc);
                        }
                        if (stm.inTransaction()) {
                            if (util.hasOwnProp.call(desc, 'get') ||
                                util.hasOwnProp.call(desc, 'set')) {
                                throw new AccessorDescriptorsNotSupportedException(desc);
                            } else {
                                if ('value' in desc &&
                                    (!util.isPrimitive(desc.value)) &&
                                    (!stm.isProxied(desc.value))) {
                                    // the value is not a tvar, explode
                                    throw new NotATVarException(desc.value);
                                }
                                current = handler.getOwnPropertyDescriptor(name);
                                if (undefined === current) {
                                    if (Object.isExtensible(self.proxied)) {
                                        // fill in the default values
                                        desc.writable = desc.writable || false;
                                        desc.enumerable = desc.enumerable || false;
                                        desc.configurable = desc.configurable || false;
                                        desc.value = 'value' in desc ? desc.value : undefined;
                                        stm.transactionFrame.recordDefine(self, name, desc);
                                        return self.proxied;
                                    } else {
                                        throw new InvalidDescriptorException(desc);
                                    }
                                }
                                match = true;
                                for (key in desc) {
                                    if (desc[key] !== current[key]) {
                                        match = false;
                                        break;
                                    }
                                }
                                if (match) {
                                    return self.proxied;
                                }
                                if ((! current.configurable) &&
                                    (desc.configurable ||
                                     ('enumerable' in desc && desc.enumerable !== current.enumerable))) {
                                    throw new InvalidDescriptorException(desc);
                                }
                                merged = {};
                                util.shallowCopy(current, merged);
                                util.shallowCopy(desc, merged);
                                // merged should now have no missing fields
                                if (! ('value' in desc)) {
                                    // desc is a GenericDescriptor. Nothing further to do.
                                    stm.transactionFrame.recordDefine(self, name, merged);
                                    return self.proxied;
                                }
                                // From here on, desc must be DataDescriptor
                                if ('value' in current) {
                                    // current is DataDescriptor too
                                    if ((! current.configurable) &&
                                        (! current.writable) &&
                                        (desc.writable || desc.value !== current.value)) {
                                        throw new InvalidDescriptorException(desc);
                                    }
                                    stm.transactionFrame.recordDefine(self, name, merged);
                                    return self.proxied;
                                } else {
                                    // Current is Accessor; but we're converting to DataDescriptor
                                    if (current.configurable) {
                                        desc.writable = desc.writable || false;
                                        stm.transactionFrame.recordDefine(self, name, merged);
                                        return self.proxied;
                                    } else {
                                        throw new InvalidDescriptorException(desc);
                                    }
                                }
                            }
                        } else {
                            throw new WriteOutsideTransactionException();
                        }
                    },

                    erase: function (name) {
                        self.log("delete:", name);
                        var desc;
                        if ("_map" === name) {
                            return delete self.raw[name];
                        } else if (stm.inTransaction()) {
                            desc = handler.getOwnPropertyDescriptor(name);
                            if (undefined === desc) {
                                return true;
                            } else if (desc.configurable) {
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
                            util.getOwnPropertyNames(self.raw).forEach(function (name) {
                                result[name] = util.getOwnPropertyDescriptor(self.raw, name);
                            });
                            return result;
                        }
                        // As long as obj is not frozen, the proxy won't allow
                        // itself to be fixed
                        return undefined; // will cause a TypeError to be thrown
                    },

                    has: function (name) {
                        self.log("has:", name);
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
                        self.log("hasOwn:", name);
                        var desc;
                        if ("_map" !== name) {
                            stm.recordRead(self);
                        }
                        if ("_map" === name || ! stm.inTransaction()) {
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
                        self.log("get:", name);
                        var desc;
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
                                    self.log("...found.");
                                    return desc.value;
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
                        var desc, setter;
                        self.log("set:", name);
                        if ("_map" === name) {
                            self.raw[name] = val;
                            return true;
                        }
                        if (stm.inTransaction()) {
                            if (undefined === val ||
                                util.isPrimitive(val) ||
                                stm.isProxied(val)) {
                                // Note at no point do we do the real write here
                                desc = handler.getOwnPropertyDescriptor(name);
                                if (desc) {
                                    if ('writable' in desc) {
                                        if (desc.writable) {
                                            stm.transactionFrame.recordWrite(self, name, val);
                                            return true;
                                        } else {
                                            return false;
                                        }
                                    } else { // accessor
                                        setter = desc.set;
                                        if (setter) {
                                            // we assume the setter is
                                            // set up for use with atomize
                                            setter.call(receiver, val);
                                            return true;
                                        } else {
                                            return false;
                                        }
                                    }
                                } else {
                                    // ok, we don't have it on us, but what about prototypes?
                                    desc = handler.getPropertyDescriptor(name);
                                    if (desc) {
                                        if ('writable' in desc) {
                                            if (desc.writable) { // fall through
                                            } else {
                                                return false;
                                            }
                                        } else { // accessor
                                            setter = desc.set;
                                            if (setter) {
                                                // we assume the setter is
                                                // set up for use with atomize
                                                setter.call(receiver, val);
                                                return true;
                                            } else {
                                                return false;
                                            }
                                        }
                                    }
                                    if (!Object.isExtensible(receiver)) {
                                        return false;
                                    } else {
                                        stm.transactionFrame.recordWrite(self, name, val);
                                        return true;
                                    }
                                }
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

            this.suspended = true;
        }

        Transaction.prototype = {
            retryException: {
                toString: function () { return "Internal Retry Exception"; }
            },
            deleted: {
                toString: function () { return "Deleted Object"; }
            },

            log: function () {
                var args;
                if (this.stm.isLogging) {
                    args = Array.prototype.slice.call(arguments, 0);
                    args.unshift("[Txn " + this.id + "]");
                    this.stm.log.apply(this.stm, args);
                }
            },

            reset: function (createds) {
                if (0 === this.funIndex) {
                    this.readStack = [];
                } else if (util.keys(this.read).length !== 0) {
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
                if (this.deleted !== descriptor) {
                    if (util.hasOwnProp.call(descriptor, 'get') ||
                        util.hasOwnProp.call(descriptor, 'set')) {
                        throw new AccessorDescriptorsNotSupportedException(descriptor);
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
                    keys = util.keys(vars);
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
                if (util.hasOwnProp.call(this.stm, 'transactionFrame') &&
                    this.parent !== this.stm.transactionFrame &&
                    this !== this.stm.transactionFrame) {
                    throw new InternalException();
                }
                this.suspended = false;
                this.funIndex = 0;
                this.stm.transactionFrame = this;
                while (! this.suspended) {
                    try {
                        return this.commit(this.funs[this.funIndex]());
                    } catch (err) {
                        if ((! util.isPrimitive(err)) &&
                            (UnpopulatedException.prototype ===
                             Object.getPrototypeOf(err))) {
                            // if we're in an orElse, we need to
                            // pretend that we hit a retry in every
                            // branch, so that we actually do the
                            // server-side retry
                            this.funIndex = 0;
                            err = this.retryException;
                        }
                        if (err === this.retryException) {
                            this.maybeSendRetry();
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

            bumpCreated: function () {
                var keys = util.keys(this.created).sort(),
                    i, obj;
                for (i = 0; i < keys.length; i += 1) {
                    obj = this.created[keys[i]].value;
                    if (obj.version === 0) {
                        obj.version = 1;
                    }
                }
            },

            copyToParent: function (written) {
                var worklist, obj, keys, i, key;
                worklist = [this.read].concat(this.readStack);
                while (worklist.length !== 0) {
                    obj = worklist.shift();
                    keys = util.keys(obj);
                    for (i = 0; i < keys.length; i += 1) {
                        key = keys[i];
                        this.parent.read[key] = obj[key];
                    }
                }

                keys = util.keys(this.created);
                for (i = 0; i < keys.length; i += 1) {
                    key = keys[i];
                    this.parent.created[key] = this.created[key];
                }

                if (written) {
                    keys = util.keys(this.written);
                    for (i = 0; i < keys.length; i += 1) {
                        key = keys[i];
                        if (util.hasOwnProp.call(this.parent.written, key)) {
                            // parent has already written to some
                            // fields within key, so we need to merge
                            // our changes in (last writer wins, so
                            // this is quite simple):
                            util.shallowCopy(this.written[key].children,
                                             this.parent.written[key].children);
                        } else {
                            this.parent.written[key] = this.written[key];
                        }
                    }
                }
            },

            commit: function (result) {
                var success, failure, txnLog, read, written, created, self;

                this.suspended = true;

                if (util.hasOwnProp.call(this, 'parent')) {
                    // TODO - we could do a validation here - not a
                    // full commit. Would require server support.

                    this.copyToParent(true);
                    this.stm.transactionFrame = this.parent;

                    if (util.hasOwnProp.call(this, 'cont')) {
                        return this.cont(result);
                    } else {
                        return result;
                    }

                } else {
                    delete this.stm.transactionFrame;

                    read = util.keys(this.read).length !== 0;
                    written = util.keys(this.written).length !== 0;
                    created = util.keys(this.created).length !== 0;

                    if (written || created) {
                        // if we wrote or created something then we
                        // have to go to the server, but the server
                        // can only fail us if we also read.
                        txnLog = this.cerealise();
                        txnLog.type = "commit";
                        this.bumpCreated();
                        if (read) {
                            self = this;
                            success = function () {
                                self.applyWritten();
                                return self.committed(result);
                            };
                            return this.stm.server.commit(
                                txnLog, success, this.failed.bind(this), this.abort);
                        } else {
                            success = function () {};
                            failure = function () {
                                throw new InternalException();
                            }
                            this.stm.server.commit(
                                txnLog, success, failure, this.abort);
                            // server can't fail us, so don't wait for it
                            this.applyWritten();
                            return this.committed(result);
                        }
                    } else {
                        // we didn't write or create. We don't need to
                        // go to the server at all.
                        return this.committed(result);
                    }
                }
            },

            committed: function (result) {
                if (util.hasOwnProp.call(this, 'cont')) {
                    return this.cont(result);
                } else {
                    return result;
                }
            },

            failed: function () {
                // Created vars will be grabbed even on a failed
                // commit. Thus do a full reset here.
                this.reset(true);
                return this.run();
            },

            applyWritten: function () {
                var ids, i,j, parent, tvar, names, name, value;
                ids = util.keys(this.written).sort();
                for (i = 0; i < ids.length; i += 1) {
                    parent = this.written[ids[i]];
                    tvar = parent.tvar;
                    tvar.version += 1;
                    this.log("incr tvar", tvar.id, "to version", tvar.version);
                    names = util.keys(parent.children);
                    for (j = 0; j < names.length; j += 1) {
                        name = names[j];
                        value = parent.children[name];
                        if (this.deleted === value) {
                            this.log("Committing delete to", ids[i], ".", name);
                            delete tvar.raw[name];
                        } else {
                            this.log("Committing write to", ids[i], ".", name);
                            // mess for dealing with arrays, defineProperty, and some proxy mess
                            if (tvar.isArray && 'length' === name) {
                                tvar.raw[name] = value.value;
                            } else {
                                util.defineProperty(tvar.raw, name, value);
                            }
                        }
                    }
                }
            },

            retry: function () {
                this.funIndex = (this.funIndex + 1) % this.funs.length;
                this.suspended = this.funIndex === 0;
                throw this.retryException;
            },

            maybeSendRetry: function () {
                var self, restart, txnLog;

                if (0 === this.funIndex) {
                    // If 0 === this.funIndex then we have done a full
                    // retry and will soon be waiting on the
                    // server. Thus we should continue unwinding the
                    // stack and thus rethrow if we have a parent. If
                    // we don't have a parent then we should absorb
                    // the exception and actually issue the retry to
                    // the server.

                    this.suspended = true;

                    if (util.hasOwnProp.call(this, 'parent')) {
                        this.copyToParent(false);
                        // We want to do a full retry, so we need to
                        // make sure our parent wants to do a full
                        // retry too.
                        this.parent.funIndex = 0;
                        this.stm.transactionFrame = this.parent;
                        throw this.retryException;

                    } else {
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
                } else {
                    // If 0 !== this.funIndex then we're in an orElse
                    // and we've hit a retry which we're going to
                    // service by changing to the next alternative and
                    // going round the run loop again. Thus absorb the
                    // exception, and don't exit the run loop. Do a
                    // partial reset - throw out the writes but keep
                    // the reads that led us here (and keep the
                    // creates; they won't be grabbed by the server
                    // until we talk to the server).
                    this.reset(false);
                }
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
                    keys = util.keys(this.created).sort();
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
                        keys = util.keys(value).sort();
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
                    keys = util.keys(this.written).sort();
                    for (i = 0; i < keys.length; i += 1) {
                        parent = {};
                        obj.written[keys[i]] = parent;
                        names = util.keys(this.written[keys[i]].children);
                        for (j = 0; j < names.length; j += 1) {
                            value = this.written[keys[i]].children[names[j]];
                            if (this.deleted === value) {
                                parent[names[j]] = {deleted: true};
                            } else if (util.isPrimitive(value.value)) {
                                parent[names[j]] = value;
                            } else {
                                desc = {};
                                util.shallowCopy(value, desc);
                                delete desc.value;
                                desc.tvar = this.stm.asTVar(value.value).id;
                                parent[names[j]] = desc;
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

            this.objToTVar = new util.Map();
            this.proxiedToTVar = new util.Map();
            this.idToTVar = {};
            this.retryException = {};
            this.server = this.noopServer();
            this.root();
            this.logPrefix = "";
        };

        STM.prototype = {
            isLogging: false,

            logging: function (bool) {
                this.isLogging = bool;
            },

            setLogPrefix: function (prefix) {
                this.logPrefix = prefix;
            },

            log: function () {
                var args;
                if (this.isLogging) {
                    args = Array.prototype.slice.call(arguments, 0);
                    if (0 !== this.logPrefix.length) {
                        args.unshift(this.logPrefix);
                        console.log.apply(console, args);
                    } else {
                        console.log.apply(console, args);
                    }
                }
            },

            noopServer: function () {
                var self = this;
                return {
                    commit: function (txnLog, success, failure) {
                        self.log("Committing txn log:", txnLog);
                        return success();
                    },

                    retry: function (txnLog, restart) {
                        // default implementation is just going to spin on
                        // this for the time being.
                        self.log("Retry with txn log:", txnLog);
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
                    objs = Array.prototype.slice.call(arguments, 0),
                    cont = objs.shift(),
                    fun, i;
                for (i = 0; i < objs.length; i += 1) {
                    objs[i] = self.lift(objs[i]);
                }
                fun = function (copies) {
                    var i, j, obj, keys, seen, delta, prev, field, deltas, copies2, retry;
                    self.atomically(
                        function () {
                            deltas = new util.Map();
                            copies2 = new util.Map();
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
                var tvar, result;
                tvar = this.asTVar(obj);
                if (undefined === tvar) {
                    result = obj[field];
                    if (typeof result === 'function') {
                        return result.bind(obj);
                    } else {
                        return result;
                    }
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
                keys = util.keys(updates);
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

                    names = util.keys(tvar.raw);
                    for (j = 0; j < names.length; j += 1) {
                        if ("_map" !== names[j] && ! util.hasOwnProp.call(update.value, names[j])) {
                            delete tvar.raw[names[j]];
                        }
                    }

                    names = util.keys(update.value);
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
                        util.defineProperty(tvar.raw, name, desc);
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
                    util.defineProperty(tvar.raw, name, desc2);
                }
            }
        };

    }());

    (function () {
        var compatNeeded = false,
            publicMethods = ['logging', 'setLogPrefix', 'inTransaction', 'orElse',
                             'atomically', 'retry', 'lift', 'access', 'assign',
                             'enumerate', 'has', 'erase', 'watch'],
            atomizeImpl;

        Atomize = function () {
            var args = Array.prototype.slice.call(arguments, 0),
                stm = new STM();
            util.lift(stm, this, publicMethods);
            this.root = stm.root();
            atomizeImpl(this, stm, args);
        };
        Atomize.prototype = {
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

            atomizeImpl = function (external, stm, args) {
                var ClientCtor = args[0],
                    serverEventEmitter = args[1],
                    inflight = {},
                    resultFuns = [],
                    FakeConn, client;

                if (compatNeeded) {
                    require('./compat').compat.load(stm);
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
                            stm.log("[Txn " + txnId + "] response received:", txnLog.result);
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
                            stm.log("Received Updates:", txnLog);
                            runResultFuns();
                            stm.applyUpdates(txnLog.updates);
                            break;
                        default:
                            stm.log("Confused");
                        }
                    }
                };

                client = new ClientCtor(new FakeConn(), serverEventEmitter);

                stm.server = {
                    commit: function (txnLog, success, failure, abort) {
                        var serialised = Cereal.stringify(txnLog),
                            obj = {txnLog: serialised,
                                   success: success,
                                   failure: failure,
                                   abort: abort};
                        inflight[txnLog.txnId] = obj;
                        stm.log("[Txn " + txnLog.txnId + "] sending commit:", txnLog);
                        client.dispatch(serialised);
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
                        stm.log("[Txn " + txnLog.txnId + "] sending retry:", txnLog);
                        client.dispatch(serialised);
                        // set this *after* we've potentially already run it...!
                        obj.runImmediately = true;
                        runResultFuns();
                    }
                };
            };

            exports.Atomize = Atomize;
            exports.Map = util.Map;

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

                atomizeImpl = function (external, stm) {
                    if (compatNeeded) {
                        AtomizeCompat.load(stm);
                    }

                    external.connect = function () {
                        external.onAuthenticated();
                    };
                };

            } else {

                atomizeImpl = function (external, stm, args) {
                    var url = args[0],
                        inflight = {},
                        queue = [],
                        reconnector,
                        drainEnqueued,
                        sockjs;

                    if (compatNeeded) {
                        AtomizeCompat.load(stm);
                    }

                    if (undefined === url) {
                        if (location.protocol !== 'http:' &&
                            location.protocol !== 'https:') {
                            console.warn("No url provided. Assuming offline-mode.");
                        } else {
                            url = location.protocol + '//' + location.host + '/atomize';
                        }
                    }

                    if (undefined !== url) {
                        external.ready = false;

                        reconnector = {
                            initialDelay: 2000, // 2 seconds
                            maxDelay: 180000,   // 3 minutes

                            connected: function () {
                                stm.log("Connected");
                                reconnector.reconnect = true;
                                reconnector.delay = reconnector.initialDelay;
                            },

                            connect: function () {
                                stm.log("Attempting connection");
                                external.connect();
                            },

                            disconnected: function () {
                                stm.log("Disconnected");
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
                                sockjs.send(queue[i]);
                            }
                            queue = [];
                        };

                        external.close = function () {
                            reconnector.reconnect = false;
                            sockjs.close();
                        };

                        external.connect = function () {
                            reconnector.connected();
                            sockjs = new SockJS(url);

                            sockjs.onopen = function () {
                                stm.log("Connected to server", url,
                                        "(using", sockjs.protocol, ")");
                                reconnector.connected();
                                external.ready = external.onPreAuthenticated(undefined, sockjs);
                                if (external.ready) {
                                    drainEnqueued();
                                    external.onAuthenticated();
                                } else {
                                    return;
                                }
                            };

                            sockjs.onclose = function (e) {
                                var keys, i, obj;
                                stm.log("Disconnected from server", url,
                                        "(", e.status, e.reason, ")");
                                external.ready = false;
                                keys = util.keys(inflight).sort();
                                for (i = 0; i < keys.length; i += 1) {
                                    queue.push(inflight[keys[i]].txnLog);
                                }
                                reconnector.disconnected();
                            };

                            sockjs.onmessage = function (e) {
                                var txnLog, txnId, txn, fun;
                                if (!external.ready) {
                                    external.ready = external.onPreAuthenticated(e, sockjs);
                                    if (external.ready) {
                                        drainEnqueued();
                                        external.onAuthenticated();
                                    }
                                    return; // authentication consumed e, so return here
                                }
                                txnLog = Cereal.parse(e.data);
                                switch (txnLog.type) {
                                case 'result':
                                    txnId = txnLog.txnId;
                                    txn = inflight[txnId];
                                    delete inflight[txnId];
                                    stm.log("[Txn " + txnId + "] response received:", txnLog.result);
                                    fun = txn[txnLog.result];
                                    if (undefined !== fun && undefined !== fun.call) {
                                        fun();
                                    }
                                    break;
                                case 'updates':
                                    stm.log("Received Updates:", txnLog);
                                    stm.applyUpdates(txnLog.updates);
                                    break;
                                default:
                                    stm.log("Received unexpected message from server:",
                                            JSON.stringify(txnLog));
                                    throw new InternalException();
                                }
                            };
                        };

                        stm.server = {
                            commit: function (txnLog, success, failure, abort) {
                                var serialised = Cereal.stringify(txnLog),
                                    obj = {txnLog: serialised,
                                           success: success,
                                           failure: failure,
                                           abort: abort};
                                inflight[txnLog.txnId] = obj;
                                if (! external.ready) {
                                    queue.push(serialised);
                                    return;
                                }
                                stm.log("[Txn " + txnLog.txnId + "] sending commit:", txnLog);
                                sockjs.send(serialised);
                            },

                            retry: function (txnLog, restart, abort) {
                                var serialised = Cereal.stringify(txnLog),
                                    obj = {txnLog: txnLog,
                                           restart: restart,
                                           abort: abort};
                                inflight[txnLog.txnId] = obj;
                                if (! external.ready) {
                                    queue.push(serialised);
                                    return;
                                }
                                stm.log("[Txn " + txnLog.txnId + "] sending retry:", txnLog);
                                sockjs.send(serialised);
                            }
                        };
                    }
                };
            }
        }

    }());

}(this));
