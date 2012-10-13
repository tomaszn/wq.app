/*!
 * wq.app - app.js
 * Utilizes store and pages to dynamically load and render
 * content from a wq.db-compatible REST service
 * (c) 2012 S. Andrew Sheppard
 * http://wq.io/license
 */

define(['./lib/jquery', './lib/jquery.mobile',
        './store', './pages', './template'],
function($, jqm, ds, pages, tmpl) {

var app = {};

app.init = function(config, templates, svc) {
    if (svc === undefined)
       svc = '';
    app.config = app.default_config = config;
    app.native = !!window.cordova;
    ds.init(svc, {'format':'json'}, {'applyResult': _applyResult});
    pages.init();
    tmpl.init(templates, templates.partials, config.defaults);
    tmpl.setDefault('native', app.native);

    var user = ds.get('user');
    if (user) {
        app.user = user;
        tmpl.setDefault('user', user);
        app.config = ds.get({'url': 'config'});
    } else if (document.cookie) {
        app.check_login();
    }

    if (config.transitions) {
        if (config.transitions.default)
            jqm.defaultPageTransition = config.transitions.default;
        if (config.transitions.dialog)
            jqm.defaultDialogTransition = config.transitions.dialog;
        if (config.transitions.save)
            _saveTransition = config.transitions.save;
        jqm.maxTransitionWidth = config.transitions.maxwidth || 800;
    }
    
    pages.register('logout\/?', app.logout);
    for (var page in config.pages) {
        var conf = config.pages[page];
        if (conf.list) {
            _registerList(page);
            _registerDetail(page);
            _registerEdit(page);
        } else {
            pages.register(conf.url);
        }
    }

    $('form').live("submit", _handleForm);
}

app.logout = function() {
    delete app.user;
    ds.set('user', null);
    tmpl.setDefault('user', null);
    app.config = app.default_config;
    ds.fetch({'url': 'logout'}, true, undefined, true);
};

app.save_login = function(user, config) {
    app.config = config;
    ds.set({'url': 'config'}, config);
    app.user = user;
    tmpl.setDefault('user', user);
    ds.set('user', user);
};

app.check_login = function() {
    ds.fetch({'url': 'login'}, false, function(result) {
        if (result && result.user && result.config) {
            app.save_login(result.user, result.config);
        }
    }, true);
};

// Internal variables and functions
var _saveTransition = "none";

// Wrappers for pages.register to handle common use cases

// Generate list view context and render with [url]_list template;
// handles requests for [url] and [url]/
function _registerList(page) {
    var conf = app.config.pages[page];
    pages.register(conf.url, go);
    pages.register(conf.url + '/', go);
    function go(match, ui, params) {
        if (ui && ui.options && ui.options.data) return; // Ignore form actions
        ds.getList({'url': conf.url}, function(list) {
            var pnum = 1, next = null, prev = null, filter;
            if (params) {
                if (params['page']) {
                    pnum = params['page'];
                } else {
                    filter = {};
                    for (var key in params) {
                        filter[key] = params[key];
                    }
                    conf.parents.forEach(function(p) {
                        if (p == page + 'type')
                             p = 'type';
                        if (filter[p]) {
                            filter[p + '_id'] = filter[p];
                            delete filter[p];
                        }
                    });
                }
            }
            
            var data = filter ? list.filter(filter) : list.page(pnum);

            if (pnum > 1) {
                var prevp = {'page': parseInt(pnum) - 1};
                prev = conf.url + '/?' + $.param(prevp);
            }

            if (pnum < data.info.pages) {
                var nextp = {'page': parseInt(pnum) + 1};
                next = conf.url + '/?' + $.param(nextp);
            }

            var context = {
                'list':     data,
                'page':     pnum,
                'pages':    data.info.pages,
                'per_page': data.info.per_page,
                'total':    data.info.total,
                'previous': prev ? '/' + prev : null,
                'next':     next ? '/' + next : null,
                'multiple': data.info.pages > 1
            };
            _addLookups(page, context, false);
            var url = conf.url + '/';
            if (params)
                url += "?" + $.param(params);
            pages.go(url, page + '_list', context, ui);
        });
    }
}

// Generate item detail view context and render with [url]_detail template;
// handles requests for [url]/[id]
function _registerDetail(page) {
    var conf = app.config.pages[page];
    pages.register(conf.url + '/([^/\?]+)', function(match, ui, params) {
        if (ui && ui.options && ui.options.data) return; // Ignore form actions
        if (match[1] == "new") return;
        ds.getList({'url': conf.url}, function(list) {
            var url = conf.url + '/' + match[1];
            var context = list.find(match[1]);
            if (!context) {
                pages.notFound(url)
                return;
            }
            _addLookups(page, context, false);
            pages.go(url, page + '_detail', context, ui);
        });
    });
}

// Generate item edit context and render with [url]_edit template;
// handles requests for [url]/[id]/edit and [url]/new
function _registerEdit(page) {
    var conf = app.config.pages[page];
    pages.register(conf.url + '/([^/]+)/edit', go);
    pages.register(conf.url + '/new', go);
    function go(match, ui, params) {
        var context, url;
        if (match && match[1]) {
            // Edit existing item
            url = match[1] + '/edit';
            context = ds.find({'url': conf.url}, match[1]);
            if (!context) {
               pages.notFound(url)
               return;
            }
            _addLookups(page, context, true);
        } else {
            // Create new item
            context = {} //FIXME: defaults
            _addLookups(page, context, true);
            if (conf.annotated) {
              context['annotations'] = [];
              var types = ds.filter({'url': 'annotationtypes'}, {'for': page});
              $.each(types, function(i, t) {
                 context['annotations'].push({'annotationtype_id': t.id});
              });
            }
            url = 'new';
        }
        pages.go(conf.url + '/' + url, page + '_edit', context, ui);
    }
}

// Handle form submit from [url]_edit views
function _handleForm(evt) {
    evt.preventDefault();
    var $form = $(this);
    var url = $form.attr('action').substring(1);
    var conf = _getConfByUrl(url);

    var vals = {};
    if (app.native) {	
	$.each($form.serializeArray(), function(i, v) {
	    vals[v.name] = v.value;
	});
    } else {
        vals.data = new FormData(this);
    }
    
    vals.url = url;
    if (url == conf.url + "/" || !conf.list)
        vals.method = "POST"; // REST API uses POST for new records
    else
        vals.method = "PUT";  // .. but PUT to update existing records
    $('.error').html('');
    ds.save(vals, undefined, function(item) {
        if (item && item.saved) {
            // Save was successful
            var data = ds.find({'url': conf.url}, item.newid);
            var options = {'reverse': true, 'transition': _saveTransition};
            jqm.changePage('/' + conf.url + '/' + data.id, options);
        } else {
            if (item && item.error && item.error.field_errors) {
                // Rest API provided detailed error information
                for (f in item.error.field_errors) {
                    var err = item.error.field_errors[f][0];
                    $('.' + conf.page + '-' + f + '-errors', $form).html(err);
                }
            } else {
                // Save failed for some unknown reason
                $('.' + conf.page + '-errors', $form).html("Error saving data.");
            }
        }
    });
}

// Successful results from REST API contain the newly saved object
function _applyResult(item, result) {
    if (result && result.id) {
        var conf = _getConfByUrl(item.data.url);
        item.saved = true;
        item.newid = result.id;
        ds.updateList({'url': conf.url}, [result], 'id');
        if (result.updates) {
            for (var page in result.updates) {
                var pconf = app.config.pages[page];
                ds.updateList({'url': pconf.url}, result.updates[page], 'id');
            }
        }
    } else if (result && result.user && result.config) {
        app.save_login(result.user, result.config);
        pages.go("login", "login");
    }
}

// Add various callback functions to context object to automate foreign key 
// lookups within templates
function _addLookups(page, context, editable) {
    var conf = app.config.pages[page];
    $.each(conf.parents, function(i, v) {
        context[v] = _parent_lookup(v)
        if (editable)
           context[app.config.pages[v].url] = _parent_dropdown_lookup(v);
    });
    $.each(conf.children, function(i, v) {
        context[app.config.pages[v].url] = _children_lookup(page, v)
    });
    if (conf.annotated) {
        context['annotations']    = _annotation_lookup(page);
        context['annotationtype'] = _parent_lookup('annotationtype');
    }
}

// Simple foreign key lookup
function _parent_lookup(page) {
    return function() {
        var conf = app.config.pages[page]
        return ds.find({'url': conf.url}, this[page + '_id']);
    }
}

// List of all potential foreign key values (useful for generating dropdowns)
function _parent_dropdown_lookup(page) {
    return function() {
        var conf = app.config.pages[page];
        var obj = this;
        var list = [];
        $.each(ds.get({'url': conf.url}), function(i, v) {
            var item = $.extend({}, v);
            if (item.id == obj[page + '_id'])
                item.selected = true; // Currently selected item
            list.push(item);
        }); 
        return list;
    }
}

// List of objects with a foreign key pointing to this one
function _children_lookup(ppage, cpage) {
    return function() {
        var conf = app.config.pages[cpage];
        var filter = {};
        filter[ppage + '_id'] = this.id;
        return ds.filter({'url': conf.url}, filter);
    }
}

// List of annotations for this object
// (like _children_lookup but with a dropdown helper)
function _annotation_lookup(page) {
    return function() {
        var conf = app.config.pages[page];
        var filter = {};
        filter[page + '_id'] = this.id;
        var list = [];
        $.each(ds.filter({'url': 'annotations'}, filter), function(i, v) {
            var item = $.extend({}, v);
            item.selected = function(){return this == item.value};
            list.push(item);
        });
        return list;
    }
}

// Helper to load configuration based on URL 
function _getConfByUrl(url) {
    var parts = url.split('/');
    var conf;
    for (var p in app.config.pages)
        if (app.config.pages[p].url == parts[0]) {
            conf = $.extend({}, app.config.pages[p]);
            conf.page = p;
        }
    return conf;
}

return app;

});