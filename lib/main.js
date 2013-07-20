/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

let { Cc, Ci, Cr } = require("chrome");

// Boilerplate to make this jetpack feel like Gecko.
let Services = {
  tm: Cc["@mozilla.org/thread-manager;1"].getService(Ci.nsIThreadManager),
  logins: Cc["@mozilla.org/login-manager;1"].getService(Ci.nsILoginManager),
  obs: Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService),
};

let XPCOMUtils = {
  makeQI: function(interfaceNames) {
    return function XPCOMUtils_QueryInterface(iid) {
      if (iid.equals(Ci.nsISupports))
        return this;
      if (iid.equals(Ci.nsIClassInfo) && "classInfo" in this)
        return this.classInfo;
      for each(let interfaceName in interfaceNames) {
        if (Ci[interfaceName].equals(iid))
          return this;
      }
      throw Cr.NS_ERROR_NO_INTERFACE;
    };
  },
  generateQI: function XPCU_generateQI(interfaces) {
    /* Note that Ci[Ci.x] == Ci.x for all x */
    return this.makeQI([Ci[i].name for each (i in interfaces) if (Ci[i])]);
  }
};

let PlacesUtils = {
  bookmarks: Cc["@mozilla.org/browser/nav-bookmarks-service;1"].getService(Ci.nsINavBookmarksService)
};

let CommonUtils = {
  bytesAsHex: function bytesAsHex(bytes) {
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += ("0" + bytes[i].charCodeAt().toString(16)).slice(-2);
    }
    return hex;
  }
};

let CryptoUtils = {
  _utf8Converter: (function () {
    converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
                createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    return converter;
  })(),
  digestUTF8: function digestUTF8(message, hasher) {
    let data = this._utf8Converter.convertToByteArray(message, {});
    hasher.update(data, data.length);
    let result = hasher.finish(false);
    if (hasher instanceof Ci.nsICryptoHMAC) {
      hasher.reset();
    }
    return result;
  },
  UTF8AndSHA1: function UTF8AndSHA1(message) {
    let hasher = Cc["@mozilla.org/security/hash;1"].
                 createInstance(Ci.nsICryptoHash);
    hasher.init(hasher.SHA1);
    return CryptoUtils.digestUTF8(message, hasher);
  },
  sha1: function sha1(message) {
    return CommonUtils.bytesAsHex(this.UTF8AndSHA1(message));
  }
};

// Dispatch a callback to be processed during some future event loop iteration.                                                                                                 
let nextTick = (function () {
  return function(fun) {
    Services.tm.currentThread.dispatch(fun, Ci.nsIThread.DISPATCH_NORMAL);
  };
})();

// Return a value, or a default value if !value is true.
function withDefault(value, dflt) {
  return value ? value : dflt;
}

// A fake database used for testing.
let db = {
  get: function (id, options, fun) {
    fun(true, null);
  },
  put: function (doc) {
    console.log(JSON.stringify(doc));
  }
};

// Abstract the login manager. The login manager has a completely synchronous
// API which sucks.
let logins = {
  createInstance: function(hostname, formSubmitURL, httpRealm,
                           username, password, usernameField, passwordField) {
    let login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init(hostname, formSubmitURL, httpRealm, username,
               password, usernameField, passwordField);
    return login;
  },
  // Find any matching logins.
  find: function(login, fun, done) {
    let result = Services.logins.findLogins({},
                                            login.hostname,
                                            withDefault(login.formSubmitURL, null),
                                            withDefault(login.httpRealm, null));
    fun && result.forEach(fun);
    done && done();
  },
  // Remove a login.
  remove: function(login) {
    Services.logins.removeLogin(login);
  },
  // Modify the first matching login, and delete all other. If no login matches,
  // add a new login.
  modify: function(login) {
    let n = 0;
    this.find(login, function (result) {
      if (!n++) {
        Services.logins.modifyLogin(result, login);
        return;
      }
      // Delete any additional logins that match instead of creating dupes.
      Services.logins.removeLogin(result);
    }, function () {
      // If we didn't find any logins to update, add a new login.
      if (!n)
        Services.logins.addLogin(login);
    });
  },
  // Execute a callback for all logins.
  all: function(fun, done) {
    fun && Services.logins.getAllLogins().forEach(fun);
    done && done();
  }
};

// Adapter to connect a database to the password service.                                                                                                                       
function PasswordAdapter(db) {
  this._db = db;
}
PasswordAdapter.prototype = {
  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIObserver,
    Ci.nsISupportsWeakReference
  ]),
  // Start listening to changes.
  start: function () {
    Services.obs.addObserver(this, "passwordmgr-storage-changed", true);
  },
  // Stop listening to changes.
  stop: function () {
    Services.obs.removeObserver(this, "passwordmgr-storage-changed");
  },
  // Convert a nsILoginInfo object to a doc.
  toDoc: function (login) {
    let obj = {
      hostname: login.hostname,
      username: login.username,
      password: login.password
    };
    let parts;
    if (login.formSubmitURL) {
      parts = [login.hostname, "form", login.formSubmitURL];
      obj.formSubmitURL = login.formSubmitURL;
      obj.usernameField = login.usernameField;
      obj.passwordField = login.passwordField;
    } else {
      parts = [login.hostname, "http", login.httpRealm];
      obj.httpRealm = login.httpRealm;
    }
    obj._id = parts.join("|");
    return obj;
  },
  // Convert a doc to a nsILoginInfo object.
  fromDoc: function (doc) {
    if (doc.formSubmitURL) {
      return logins.createInstance(doc.hostname,
                                   doc.formSubmitURL,
                                   null,
                                   doc.username,
                                   doc.password,
                                   doc.usernameField,
                                   doc.passwordField);
    }
    return logins.createInstance(doc.hostname,
                                 null,
                                 doc.httpRealm,
                                 doc.username,
                                 doc.password,
                                 "",
                                 "");
  },
  // Observe changes to logins and forward them to the db.
  observe: function (subject, topic, data) {
    switch (data) {
    case "modifyLogin":
      subject = subject.QueryInterface(Ci.nsIArray).queryElementAt(1, Ci.nsILoginMetaInfo);
      // fallthrough
    case "addLogin":
    case "removeLogin":
      subject = subject.QueryInterface(Ci.nsILoginMetaInfo).QueryInterface(Ci.nsILoginInfo);
      break;
    }
    let login = subject;
    let newDoc = this.toDoc(login);
    db.get(newDoc._id, {}, function (err, oldDoc) {
      // If the login is going away and we have found the doc, remove it.
      if (data === "removeLogin") {
        if (oldDoc) {
          db.remove(oldDoc);
        }
        return;
      }
      // Add or update doc.
      if (oldDoc) {
        // If the db already contains the current doc, we are done.
        if (login.matches(this.fromDoc(oldDoc), false))
          return;
        newDoc._rev = oldDoc._rev;
      }
      db.put(newDoc);
    });
  },
  // Force a synchronization of all logins with the database.
  sync: function(done) {
    let self = this;
    logins.all(function (login) {
      // Send a custom notification that forces us to look up the login and
      // compare it to the state we have in the database.
      self.observe(login, "", "syncLogin");
    }, done);
  },
  // Process changes that were detected during replication. The changes must
  // include the doc.
  changes: function(changes, done) {
    changes.forAll(function (change) {
      let login = this.fromDoc(change.doc);
      // Process deletions.
      if (change.deleted) {
        removeLogins(login);
        return;
      }
      updateLogins(login);
    });
    done && done();
  }
};

// Abstract away the bookmark service. As the login manager, the bookmark
// service is completely synchronous, which really blows.
let bookmarks = {
  list: function (folder, fun, done) {
    let bm = PlacesUtils.bookmarks;
    // Retrieve the id for each entry in this folder, in order.
    let result = [];
    let n = 0;
    while (true) {
      let id = bm.getIdForItemAt(folder, n++);
      if (id === -1)
        break;
      result.push(id);
    }
    // Retrieve the actual fields for each item.
    for (let n = 0; n < result.length; ++n) {
      let id = result[n];
      let type = bm.getItemType(id);
      let item = {};
      if (type !== bm.TYPE_SEPARATOR)
        item.title = bm.getItemTitle(id);
      if (type === bm.TYPE_BOOKMARK)
        item.uri = bm.getBookmarkURI(id).spec;
      if (type === bm.TYPE_FOLDER)
        item.id = id;
      result[n] = item;
    }
    fun && result.forEach(fun);
    done && done();
  }
};

function BookmarkAdaptor(db) {
  this._db = db;
}
BookmarkAdaptor.prototype = {
  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsINavBookmarkObserver,
    Ci.nsISupportsWeakReference
  ]),
  // Start listening to changes.
  start: function () {
    PlacesUtils.bookmarks.addObserver(this, true);
  },
  // Stop listening to changes.
  stop: function () {
    PlacesUtils.bookmarks.removeObserver(this);
  },
};

let adaptor = new BookmarkAdaptor();
adaptor.start();

function dump(item) {
  console.log(item.id, item.title, item.uri);
  if (item.id)
    bookmarks.list(item.id, dump);
}
bookmarks.list(PlacesUtils.bookmarks.placesRoot, dump);
