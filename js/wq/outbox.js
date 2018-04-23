/*!
 * wq.app 1.1.1-dev - wq/outbox.js
 * Queue submitted forms for eventual syncing to the server
 * (c) 2012-2017, S. Andrew Sheppard
 * https://wq.io/license
 */

define(['jquery', 'localforage', 'json-forms',
        './store', './model', './json', './console'],
function($, lf, jsonforms, ds, model, json, console) {

var _outboxes = {};
var outbox = new _Outbox(ds);

outbox.getOutbox = function(store) {
    if (_outboxes[store.name]) {
        return _outboxes[store.name];
    } else {
        return new _Outbox(store);
    }
};

// plug outbox capabilities into wq/model
model.Model.prototype.unsyncedItems = function(withData) {
    return outbox.getOutbox(
        this.store
    ).unsyncedItems(this.query, withData);
};

model.Model.prototype.find_with_unsynced = function(value, attr, localOnly, withData) {
    var model = this;
    return model.find(value, attr, localOnly).then(function(item) {
        if (item == null) {
            return model.unsyncedItems(withData).then(function(unsynced_items) {
                if (!attr) {
                    attr = 'id';
                }
                if (model.store.debugLookup) {
                    console.log('not found, trying in unsynced');
                }
                item = unsynced_items.find(function(unsynced) {
                    var value_here = (attr == 'id')?
                        'outbox-' + unsynced.id : unsynced.data[attr];
                    if (value_here == value) {
                        return true;
                    }
                });
                if (item) {
                    var result = item.data;
                    result.id = 'outbox-' + item.id;
                    return result;
                }

            });
        } else return item;
    });
};

return outbox;

function _Outbox(store) {
    var self = _outboxes[store.name] = this;

    self.store = store;
    self.model = model({'query': 'outbox', 'store': store});
    self.model.overwrite = _wrapOverwrite(self.model.overwrite);
    self.syncMethod = 'POST';
    self.cleanOutbox = true;
    self.maxRetries = 3;
    self.csrftoken = null;
    self.csrftokenField = 'csrfmiddlewaretoken';

    self.init = function(opts) {

        var optlist = [
            // Default to store values but allow overriding
            'service',
            'formatKeyword',
            'defaults',
            'debugNetwork',
            'debugValues',

            // Outbox-specific options
            'syncMethod',
            'cleanOutbox',
            'maxRetries',
            'batchService',
            'csrftokenField',

            // Outbox functions
            'validate',
            'applyResult',
            'updateModels',
            'parseBatchResult'
        ];
        optlist.forEach(function(opt) {
            if (self.store.hasOwnProperty(opt)) {
                self[opt] = self.store[opt];
            }
            if (opts && opts.hasOwnProperty(opt)) {
                self[opt] = opts[opt];
            }
        });

        if (self.cleanOutbox) {
            // Clear out successfully synced items from previous runs, if any
            // FIXME: should we hold up init until this is done?
            self.unsyncedItems().then(self.model.overwrite);
        }

        if (self.batchService && !self.parseBatchResult) {
            self.parseBatchResult = self.store.parseData;
        }
    };

    self.setCSRFToken = function(csrftoken) {
        self.csrftoken = csrftoken;
    };

    // Queue data for server use; use outbox to cache unsynced items
    self.save = function(data, options, noSend) {
        if (!options) {
            options = {};
        }
        if (!self.validate(data, options)) {
            return Promise.resolve(null);
        }
        var getItem;
        if (options.id) {
            getItem = self.loadItem(options.id).then(function(item) {
                if (item && !item.synced) {
                    // reuse existing item
                    (options.preserve || []).forEach(function(field) {
                        if (data[field] === undefined) {
                            data[field] = item.data[field];
                        }
                    });
                    item.data = data;
                    item.retryCount = 0;
                    item.error = null;
                    item.options = options;
                    return item;
                } else {
                    return newItem();
                }
            });
        } else {
            getItem = newItem();
        }

        function newItem() {
            return self.model.load().then(function(obdata) {
                var maxId = 0;
                obdata.list.forEach(function(obj) {
                    if (obj.id > maxId) {
                        maxId = obj.id;
                    }
                });
                return {
                    data: data,
                    synced: false,
                    id: maxId + 1,
                    options: options
                };
            });
        }

        return getItem.then(function(item) {
            if (item.options.label) {
                item.label = item.options.label;
                delete item.options.label;
            }
            Object.keys(data).forEach(function(key) {
                var match = (
                    data[key].match && data[key].match(/^outbox-(\d+)$/)
                );
                if (match) {
                    if (!item.parents) {
                        item.parents = [];
                    }
                    item.parents.push(match[1]);
                }
            });

            return self.model.update([item]).then(function() {
                if (noSend) {
                    return item;
                } else {
                    return self.sendItem(item);
                }
            });
        });
    };

    // Validate a record before adding it to the outbox
    self.validate = function(data, options) {
        /* jshint unused: false */
        return true;
    };

    // Send a single item from the outbox to the server
    self.sendItem = function(item, once) {
        if (!item || item.synced || !item.data) {
            return Promise.resolve(null);
        }

        var data = item.data;
        var options = item.options;
        var url = self.service;
        if (options.url) {
            url = url + '/' + options.url;
        }
        var method = options.method || self.syncMethod;
        var headers = {};

        // Use current CSRF token in case it's changed since item was saved
        var csrftoken = self.csrftoken || options.csrftoken;
        if (csrftoken) {
            headers['X-CSRFToken'] = csrftoken;
            data = json.extend({}, data);
            data[self.csrftokenField] = csrftoken;
        }

        var defaults = json.extend({}, self.defaults);
        if (defaults.format && !self.formatKeyword) {
            url = url.replace(/\/$/, '');
            url += '.' + defaults.format;
            delete defaults.format;
        }
        if (json.param(defaults)) {
            url += '?' + json.param(defaults);
        }

        if (self.debugNetwork) {
            console.log("Sending item to " + url);
            if (self.debugValues) {
                console.log(data);
            }
        }

        // If files/blobs are present, use a FormData object to submit
        var formData = (window.FormData && new FormData());
        var useFormData = false;
        var key, val, blob, slice;
        for (key in data) {
            val = data[key];
            if (!val) {
                continue;
            }
            if (json.isArray(val) || (val.name && val.type && val.body)) {
                useFormData = true;
            }
        }
        if (useFormData) {
            if (!formData) {
                throw "FormData needed but not present!";
            }
            for (key in data) {
                val = data[key];
                if (json.isArray(val)) {
                    val.forEach(appendValue.bind(this, key));
                } else {
                    appendValue(key, val);
                }
            }
        }

        function appendValue(key, val) {
            if (val && val.name && val.type && val.body) {
                // File (Blob) record; add with filename
                blob = val.body;
                if (!blob.type) {
                    // Serialized blobs lose their type
                    slice = blob.slice || blob.webkitSlice;
                    blob = slice.call(blob, 0, blob.size, val.type);
                }
                formData.append(key, blob, val.name);
            } else {
                // Add regular form fields
                formData.append(key, val);
            }
        }

        return Promise.resolve($.ajax(url, {
            data: useFormData ? formData : data,
            type: method,
            dataType: "json",
            processData: !useFormData,
            contentType: useFormData ? false : undefined,
            async: true,
            headers: headers
        })).then(sendItemSuccess, sendItemError);

        function sendItemSuccess(result) {
            if (self.debugNetwork) {
                console.log("Item successfully sent to " + url);
            }
            return self._sendItemSuccessProcess(item, result);
        }

        function sendItemError(jqxhr) {
            if (self.debugNetwork) {
                console.warn("Error sending item to " + url);
            }
            return self._sendItemErrorProcess(jqxhr, item, once);
        }
    };

    self._sendItemSuccessProcess = function(item, result) {
        self.applyResult(item, result);
        if (!item.synced) {
            // sendItem did not result in sync
            item.retryCount = item.retryCount || 0;
            item.retryCount++;
        }
        return self.updateModels(item, result).then(function() {
            // update unsynced items before any updates land there
            return self.unsyncedItems().then(function(relItems) {
                relItems.forEach(function(relItem) {
                    Object.keys(relItem.data).forEach(function(key) {
                        if (relItem.data[key] === 'outbox-' + item.id) {
                            if (self.debugValues) {
                                console.log('adjusting foreign key in outbox item',
                                    relItem, key, result.id);
                            }
                            relItem.data[key] = result.id;
                        }
                    });
                });
                return self.model.update(relItems);
            }).then(function() {
                return self.model.filter({'parents': item.id}).then(function(relItems) {
                    return Promise.all(relItems.map(_loadItemData));
                }).then(function(relItems) {
                    relItems.forEach(function(relItem) {
                        relItem.parents = relItem.parents.filter(function(p) {
                            return p != item.id;
                        });
                        Object.keys(relItem.data).forEach(function(key) {
                            if (relItem.data[key] === 'outbox-' + item.id) {
                                relItem.data[key] = result.id;
                            }
                        });
                    });
                    relItems.push(_withoutData(item));
                    return self.model.update(relItems);
                });
            });
        }).then(function() {
            return item;
        });
    };

    self._sendItemErrorProcess = function(jqxhr, item, once) {
        if (jqxhr.responseText) {
            try {
                item.error = JSON.parse(jqxhr.responseText);
            } catch (e) {
                item.error = jqxhr.responseText;
            }
        } else {
            item.error = jqxhr.status;
        }
        if (once) {
            item.locked = true;
        }
        item.retryCount = item.retryCount || 0;
        item.retryCount++;
        return self.model.update([_withoutData(item)]).then(function() {
            return item;
        });
    };

    // Send all unsynced items, using batch service if available
    self.sendAll = function(retryAll) {

        var fn = retryAll ? self.unsyncedItems : self.pendingItems,
            result = fn(null, true);

        // Utilize batch service if it exists
        if (self.batchService) {
            return result.then(self.sendBatchGeneric);
        } else {
            return result.then(self.sendItems);
        }
    };

    // Send items in sequence and retrieve results
    // based on: https://hackernoon.com/functional-javascript-resolving-promises-sequentially-7aac18c4431e
    // coverted with: https://closure-compiler.appspot.com
    var promiseSerial = function(funcs) {
        return funcs.reduce(function(promise, func) {
            return promise.then(function(result) {
                return func().then(Array.prototype.concat.bind(result));
            });
        }, Promise.resolve([]));
    };

    // Send items to a django-batch-requests endpoint on the server
    self.sendBatchGeneric = function(items) {
        if (!items.length) {
            return Promise.resolve(items);
        }

        // Assign items model's position in parents-first list
        var order = self.getModelSyncOrder();
        if (self.debugNetwork) {
            console.log('calculated model sync order is ', order);
        }

        // Use current CSRF token in case it's changed since item was saved
        var csrftoken = self.csrftoken;

        var batch_funcs = order.map(function(modelName, index) {
            return items.filter(function(item) {
                return item.options.modelConf.name == modelName;
            });
        }).filter(function(model_items) {
            return model_items.length > 0;
        }).map(function(model_items) {

            function genericBatchSuccess(r) {
                var results = self.parseBatchResult(r);
                if (!results || results.length != model_items.length) {
                    if (self.debugNetwork) {
                        console.log("BATCH: failed");
                    }
                    return null;
                } else if (self.debugNetwork) {
                    console.log("BATCH: got responses for all items");
                }

                // Apply sync results to individual items
                var funcs = model_items.map(function(item, i) {
                    return function() {
                        var batchResult = results[i];
                        // POST results in 201 Created, PUT results in 200 OK
                        if (batchResult.status_code == 201 || batchResult.status_code == 200) {
                            var result = JSON.parse(batchResult.body);
                            return self._sendItemSuccessProcess(item, result);
                        } else if (batchResult.status_code == 204) {
                            // DELETE results in 204 "No Content"
                            return self._sendItemSuccessProcess(item, false);
                        } else {
                            var fake_jqxhr = {
                                status: batchResult.status_code,
                            };
                            try {
                                fake_jqxhr.responseText = JSON.parse(batchResult.body)['detail'];
                            } catch (e) {
                                fake_jqxhr.responseText = batchResult.body;
                            }
                            return self._sendItemErrorProcess(fake_jqxhr, item, true);
                        }
                    };
                });

                return promiseSerial(funcs).then(function(sentItems) {
                    console.log('sentItems after batch result processing', sentItems);
                    // Reload data and return final result
                    return sentItems;
                });
            }
            return function() {
                // ids to check in updates
                var model_items_ids = model_items.map(function(item) {
                    return item.id;
                });

                // update them from local db, could be updated by syncing its parents
                // let's fetch it again
                return self.unsyncedItems().then(function(allUnsynced) {
                    allUnsynced.forEach(function(updated) {
                        if (model_items_ids.indexOf(updated.id) > -1) {
                            // we have it to send now, overwrite .data
                            model_items.forEach(function(item) {
                                if (item.id == updated.id) {
                                    item.data = updated.data;
                                }
                            });
                        }
                    });

                    // execute batch request
                    var masterRequest = [];
                    model_items.forEach(function(item) {
                        // Update CSRF token if it changed
                        item.data[self.csrftokenField] = csrftoken;
                        masterRequest.push({
                            url: '/' + item.options.url.replace(/\/$/, "") + '.json',
                            method: item.options.method,
                            headers: {
                                'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8",
                                'X-CSRFToken': csrftoken
                            },
                            body: json.param(item.data)
                        });
                    });
                    return Promise.resolve($.ajax(self.batchService, {
                        data: JSON.stringify(masterRequest),
                        type: "POST",
                        dataType: "json",
                        contentType: "application/json",
                        async: true
                    })).then(genericBatchSuccess);
                });
            };
        });


        return promiseSerial(batch_funcs).then(function(item_groups) {
            // merge results
            return [].concat.apply([], item_groups);
        });
    };

    // Get names of models sorted parent-first
    self.getModelSyncOrder = function() {
        var app = require('wq/app');
        var modelPages = Object.keys(app.config.pages).map(function(key) {
            return app.config.pages[key];
        }).filter(
            function(page) { return page.list; }
        );
        var prev_ready = [];
        var result = [];
        do {
            var new_ready = modelPages.filter(function(page) {
                return !page.form.some(function(field) {
                    return field['wq:ForeignKey'] &&
                        prev_ready.indexOf(field['wq:ForeignKey']) == -1;
                });
            }).map(function(page) { return page.name; });
            result = result.concat(new_ready.filter(function(model) {
                return prev_ready.indexOf(model) == -1;
            }));
            prev_ready = new_ready;
        } while (result.length < modelPages.length);
        return result;
    };

    self.sendItems = function(items) {
        // No batch service; emulate batch mode by sending each item to
        // the server and summarizing the result

        if (!items.length) {
            return Promise.resolve(items);
        }

        // Assign items model's position in parents-first list
        var order = self.getModelSyncOrder();
        if (self.debugNetwork) {
            console.log('calculated model sync order is ', order);
        }
        var allIds = [];
        items.forEach(function(item) {
            allIds.push(item.id);
            item.syncOrder = order.indexOf(item.options.modelConf.name);
        });

        // Sort them accordingly
        items = items.sort(function(a, b) {
            return a.syncOrder - b.syncOrder;
        });

        var funcs = items.map(function(a) {
            return function() {
                // "a".data could have been updated after syncing its parents
                // let's fetch it again
                return self.unsyncedItems().then(function(allUnsynced) {
                    var updated = allUnsynced.filter(function(item) {
                        return item.id == a.id; })[0];
                    if (!updated || !updated.data) {
                        console.log('anomalia! updated wyglada tak:', updated);
                    } else {
                        a.data = updated.data;
                    }
                    return self.sendItem(a).then(function(item) {
                        return self.model.update([item]);
                    });
                });
            };
        });

        return promiseSerial(funcs).then(function(sentItems) {
            // Reload data and return final result
            return self.model.filter(
                {'id': allIds}
            );
        });
    };

    // Process service send() results
    // (override to apply additional result attributes to item,
    //  but be sure to set item.synced)
    self.applyResult = function(item, result) {
        // Default: assume non-empty result means the sync was successful
        if (result) {
            item.synced = true;
            item.result = result;
        } else if (item.options.method == 'DELETE') {
            item.synced = true;
            if (item.options.modelConf) {
                item.deletedId = item.options.url.replace(
                    item.options.modelConf.url + '/', ''
                );
            }
        }
    };

    // Update any corresponding models with synced data
    self.updateModels = function(item, result) {
        if (item.options.modelConf && item.synced) {
            var conf = json.extend(
                {'store': self.store},
                item.options.modelConf
            );
            if (item.deletedId) {
                return model(conf).remove(item.deletedId);
            } else {
                return model(conf).update([result]).then(function() {
                    return result;
                });
            }
        } else {
            return Promise.resolve();
        }
    };

    // Count of unsynced outbox items (never synced, or sync was unsuccessful)
    self.unsynced = function(modelConf) {
        return self.unsyncedItems(modelConf).then(function(items) {
            return items.length;
        });
    };

    // Actual unsynced items
    self.unsyncedItems = function(modelConf, withData) {
        var result = self.model.filter({'synced': false});

        // Exclude temporary items from list
        result = result.then(function(items) {
            return items.filter(function(item) {
                if (item.options.storage == 'temporary') {
                    if (item.options.desiredStorage) {
                        return true;
                    }
                    return false;
                } else {
                    return true;
                }
            });
        });

        // Return all unsynced items by default
        if (!modelConf) {
            return result.then(loadData);
        }

        // Otherwise, only match items corresponding to the specified list
        return result.then(function(items) {
            return items.filter(function(item) {
                if (!item.options.modelConf) {
                    return false;
                }
                for (var key in modelConf) {
                    if (item.options.modelConf[key] != modelConf[key]) {
                        return false;
                    }
                }
                return true;
            });
        }).then(loadData);

        function loadData(items) {
            if (withData) {
                return Promise.all(items.map(_loadItemData));
            } else {
                return items;
            }
        }
    };

    // Unsynced items that have been sent less than maxRetries times
    self.pendingItems = function(modelConf, withData) {
        return self.unsyncedItems(
            modelConf, withData
        ).then(function(unsynced) {
            var items = [];
            unsynced.forEach(function(item) {
                if (self.maxRetries && item.retryCount >= self.maxRetries) {
                    return;
                }
                if (item.locked) {
                    return;
                }
                items.push(item);
            });
            return items;
        });
    };

    self.loadItem = function(itemId) {
        return self.model.find(itemId)
                   .then(_loadItemData)
                   .then(_parseJsonForm);
    };

    var _memoryItems = {};
    function _loadItemData(item) {
        if (!item || !item.options || !item.options.storage) {
            return item;
        } else if (item.options.storage == 'temporary') {
            return setData(item, _memoryItems[item.id]);
        } else {
            return self.store.get('outbox_' + item.id).then(function(data) {
                return setData(item, data);
            }, function() {
                return setData(item, null);
            });
        }
        function setData(obj, data) {
            if (data) {
                obj.data = data;
            } else {
                obj.label = '[Form Data Missing]';
                obj.missing = true;
            }
            return obj;
        }
    }

    function _parseJsonForm(item) {
        var values = [], key;
        for (key in item.data) {
            values.push({
                'name': key,
                'value': item.data[key]
            });
        }
        item.data = jsonforms.convert(values);
        for (key in item.data) {
            if ($.isArray(item.data[key])) {
                item.data[key].forEach(function(row, i) {
                    row['@index'] = i;
                });
            }
        }
        return item;
    }

    function _wrapOverwrite(defaultOverwrite) {
        return function(newData) {
            newData = self.model._processData(newData);
            return Promise.all(
                newData.list.map(_updateItemData)
            ).then(function(items) {
                // I can't debug what happens inside:
                // Uncaught (in promise) DOMException: Failed to read large IndexedDB value
                // but without it, it slows down with each item sent,
                // and eventually uses all memory.
                // Let's run it in 5% of cases...
                if (Math.random() < 5/100) {
                    console.log('padlo na uruchomienie _cleanUpItemData, items.length==' + items.length);
                    _cleanUpItemData(items);
                }
                return defaultOverwrite(items);
            });
        };
    }

    function _updateItemData(item) {
        if (!item.data) {
            return item;
        }
        if (!item.options || !item.options.storage) {
            return item;
        }
        if (item.options.storage == 'temporary') {
            _memoryItems[item.id] = item.data;
            return _withoutData(item);
        } else {
            return self.store.set(
                'outbox_' + item.id, item.data
            ).then(function() {
                return _withoutData(item);
            }, function() {
                console.warn(
                    "could not save form contents to storage"
                );
                item.options.desiredStorage = item.options.storage;
                item.options.storage = 'temporary';
                return _updateItemData(item);
            });
        }
    }

    function _withoutData(item) {
        if (!item.data) {
            return item;
        }
        if (!item.options || !item.options.storage) {
            return item;
        }
        var obj = {};
        Object.keys(item).filter(function(key) {
            return key != 'data';
        }).forEach(function(key) {
            obj[key] = item[key];
        });
        return obj;
    }

    function _cleanUpItemData(validItems) {
        var validId = {};
        validItems.forEach(function(item) {
            validId[item.id] = true;
        });
        Object.keys(_memoryItems).forEach(function(itemId) {
            if (!validId[itemId]) {
                delete _memoryItems[itemId];
            }
        });
        return self.store.keys().then(function(keys) {
            return Promise.all(keys.map(function(key) {
                if (key.indexOf('outbox_') === 0) {
                    var itemId = key.replace('outbox_', '');
                    if (!validId[itemId]) {
                        return self.store.set(key, null);
                    }
                }
            }));
        });
    }
}

});
