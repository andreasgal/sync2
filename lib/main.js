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

// Process the elements of an array while yielding to the event loop after                                                                                                      
// every element.                                                                                                                                                               
function forEachYield(array, fun, done) {
  let n = 0;
  function do1() {
    if (n >= array.length) {
      if (done)
        done();
      return;
    }
    fun(array[n++]);
    nextTick(do1);
  }
  do1();
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
// API which sucks. We use nextTick to make it as asynchronous as we can make
// it.
let logins = (function () {
  return {
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
      forEachYield(result, fun, done);
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
      forEachYield(Services.logins.getAllLogins(), fun, done);
    }
  };
})();

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
    forEachYield(changes, function (change) {
        let login = this.fromDoc(change.doc);
        // Process deletions.
        if (change.deleted) {
          removeLogins(login);
          return;
        }
        updateLogins(login);
      }, done);
  }
};

let login = logins.createInstance("www.foo.com",
                            null,
                            "www.foo.com",
                            "foo",
                            "bar",
                            "",
                            "");
logins.modify(login);

let adapter = new PasswordAdapter(db);
adapter.start();
// This should should the first login.
adapter.sync();

let login = logins.createInstance("www.moo.com",
                            null,
                            "www.moo.com",
                            "foo",
                            "bar",
                            "",
                            "");
// We should observe this change.
logins.modify(login);
