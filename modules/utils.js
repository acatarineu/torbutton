// # Utils.js
// Various helpful utility functions.

// ### Import Mozilla Services
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

// ### About firstPartyDomain literal
const k_tb_about_uri_first_party_domain = "about.ef2a7dd5-93bc-417f-a698-142c3116864f.mozilla";

// ## Pref utils

// __prefs__. A shortcut to Mozilla Services.prefs.
let prefs = Services.prefs;

// __getPrefValue(prefName)__
// Returns the current value of a preference, regardless of its type.
var getPrefValue = function (prefName) {
  switch(prefs.getPrefType(prefName)) {
    case prefs.PREF_BOOL: return prefs.getBoolPref(prefName);
    case prefs.PREF_INT: return prefs.getIntPref(prefName);
    case prefs.PREF_STRING: return prefs.getCharPref(prefName);
    default: return null;
  }
};

// __bindPref(prefName, prefHandler, init)__
// Applies prefHandler whenever the value of the pref changes.
// If init is true, applies prefHandler to the current value.
// Returns a zero-arg function that unbinds the pref.
var bindPref = function (prefName, prefHandler, init = false) {
  let update = () => { prefHandler(getPrefValue(prefName)); },
      observer = { observe : function (subject, topic, data) {
                     if (data === prefName) {
                         update();
                     }
                   } };
  prefs.addObserver(prefName, observer, false);
  if (init) {
    update();
  }
  return () => { prefs.removeObserver(prefName, observer); };
};

// __bindPrefAndInit(prefName, prefHandler)__
// Applies prefHandler to the current value of pref specified by prefName.
// Re-applies prefHandler whenever the value of the pref changes.
// Returns a zero-arg function that unbinds the pref.
var bindPrefAndInit = (prefName, prefHandler) =>
    bindPref(prefName, prefHandler, true);

// ## Observers

// __observe(topic, callback)__.
// Observe the given topic. When notification of that topic
// occurs, calls callback(subject, data). Returns a zero-arg
// function that stops observing.
var observe = function (topic, callback) {
  let observer = {
    observe: function (aSubject, aTopic, aData) {
      if (topic === aTopic) {
        callback(aSubject, aData);
      }
    },
  };
  Services.obs.addObserver(observer, topic, false);
  return () => Services.obs.removeObserver(observer, topic);
};

// ## Environment variables

// __env__.
// Provides access to process environment variables.
let env = Cc["@mozilla.org/process/environment;1"]
            .getService(Ci.nsIEnvironment);

// __getEnv(name)__.
// Reads the environment variable of the given name.
var getEnv = function (name) {
  return env.exists(name) ? env.get(name) : undefined;
};

// __getLocale
// Reads the browser locale, the default locale is en-US.
var getLocale = function() {
  return Services.locale.requestedLocale || "en-US";
};

// ## Windows

// __dialogsByName__.
// Map of window names to dialogs.
let dialogsByName = {};

// __showDialog(parent, url, name, features, arg1, arg2, ...)__.
// Like window.openDialog, but if the window is already
// open, just focuses it instead of opening a new one.
var showDialog = function (parent, url, name, features) {
  let existingDialog = dialogsByName[name];
  if (existingDialog && !existingDialog.closed) {
    existingDialog.focus();
    return existingDialog;
  } else {
    let newDialog = parent.openDialog.apply(parent,
                                            Array.slice(arguments, 1));
    dialogsByName[name] = newDialog;
    return newDialog;
  }
};

// ## Tor control protocol utility functions

let _torControl = {
  // Unescape Tor Control string aStr (removing surrounding "" and \ escapes).
  // Based on Vidalia's src/common/stringutil.cpp:string_unescape().
  // Returns the unescaped string. Throws upon failure.
  // Within Tor Launcher, the file components/tl-protocol.js also contains a
  // copy of _strUnescape().
  _strUnescape: function(aStr)
  {
    if (!aStr)
      return aStr;

    var len = aStr.length;
    if ((len < 2) || ('"' != aStr.charAt(0)) || ('"' != aStr.charAt(len - 1)))
      return aStr;

    const kHexRE = /[0-9A-Fa-f]{2}/;
    const kOctalRE = /[0-7]{3}/;
    var rv = "";
    var i = 1;
    var lastCharIndex = len - 2;
    while (i <= lastCharIndex)
    {
      var c = aStr.charAt(i);
      if ('\\' == c)
      {
        if (++i > lastCharIndex)
          throw new Error("missing character after \\");

        c = aStr.charAt(i);
        if ('n' == c)
          rv += '\n';
        else if ('r' == c)
          rv += '\r';
        else if ('t' == c)
          rv += '\t';
        else if ('x' == c)
        {
          if ((i + 2) > lastCharIndex)
            throw new Error("not enough hex characters");

          let s = aStr.substr(i + 1, 2);
          if (!kHexRE.test(s))
            throw new Error("invalid hex characters");

          let val = parseInt(s, 16);
          rv += String.fromCharCode(val);
          i += 3;
        }
        else if (this._isDigit(c))
        {
          let s = aStr.substr(i, 3);
          if ((i + 2) > lastCharIndex)
            throw new Error("not enough octal characters");

          if (!kOctalRE.test(s))
            throw new Error("invalid octal characters");

          let val = parseInt(s, 8);
          rv += String.fromCharCode(val);
          i += 3;
        }
        else // "\\" and others
        {
          rv += c;
          ++i;
        }
      }
      else if ('"' == c)
        throw new Error("unescaped \" within string");
      else
      {
        rv += c;
        ++i;
      }
    }

    // Convert from UTF-8 to Unicode. TODO: is UTF-8 always used in protocol?
    return decodeURIComponent(escape(rv));
  }, // _strUnescape()

  // Within Tor Launcher, the file components/tl-protocol.js also contains a
  // copy of _isDigit().
  _isDigit: function(aChar)
  {
    const kRE = /^\d$/;
    return aChar && kRE.test(aChar);
  },
}; // _torControl

// __unescapeTorString(str, resultObj)__.
// Unescape Tor Control string str (removing surrounding "" and \ escapes).
// Returns the unescaped string. Throws upon failure.
var unescapeTorString = function(str) {
  return _torControl._strUnescape(str);
};

// Returns true if we should show the tor browser manual.
var show_torbrowser_manual = () => {
  let availableLocales = ["de", "en", "es", "fr", "nl", "pt", "tr", "vi", "zh"];
  let shortLocale = getLocale().substring(0, 2);
  return availableLocales.indexOf(shortLocale) >= 0;
}

var getDomainForBrowser = (browser) => {
  let firstPartyDomain = browser.contentPrincipal.originAttributes.firstPartyDomain;
  // Bug 22538: For neterror or certerror, get firstPartyDomain causing it from the u param
  if (firstPartyDomain === k_tb_about_uri_first_party_domain) {
    let knownErrors = ["about:neterror", "about:certerror"];
    let origin = browser.contentPrincipal.origin || '';
    if (knownErrors.some(x => origin.startsWith(x))) {
      try {
        let urlOrigin = new URL(origin);
        let { hostname } = new URL(urlOrigin.searchParams.get('u'));
        if (hostname) {
          try {
            firstPartyDomain = Services.eTLD.getBaseDomainFromHost(hostname);
          } catch (e) {
            if (e.result == Cr.NS_ERROR_HOST_IS_IP_ADDRESS ||
                e.result == Cr.NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS) {
              firstPartyDomain = hostname;
            }
          }
        }
      } catch (e) {}
    }
  }
  return firstPartyDomain;
};

var m_tb_torlog = Cc["@torproject.org/torbutton-logger;1"]
.getService(Ci.nsISupports).wrappedJSObject;

var m_tb_string_bundle = torbutton_get_stringbundle();

function torbutton_safelog(nLevel, sMsg, scrub) {
    m_tb_torlog.safe_log(nLevel, sMsg, scrub);
    return true;
}

function torbutton_log(nLevel, sMsg) {
    m_tb_torlog.log(nLevel, sMsg);

    // So we can use it in boolean expressions to determine where the 
    // short-circuit is..
    return true;
}

// load localization strings
function torbutton_get_stringbundle()
{
    var o_stringbundle = false;

    try {
        var oBundle = Services.strings;
        o_stringbundle = oBundle.createBundle("chrome://torbutton/locale/torbutton.properties");
    } catch(err) {
        o_stringbundle = false;
    }
    if (!o_stringbundle) {
        torbutton_log(5, 'ERROR (init): failed to find torbutton-bundle');
    }

    return o_stringbundle;
}

function torbutton_get_property_string(propertyname)
{
    try { 
        if (!m_tb_string_bundle) {
            m_tb_string_bundle = torbutton_get_stringbundle();
        }

        return m_tb_string_bundle.GetStringFromName(propertyname);
    } catch(e) {
        torbutton_log(4, "Unlocalized string "+propertyname);
    }

    return propertyname;
}

// Bug 1506 P4: Control port interaction. Needed for New Identity.
function torbutton_socket_readline(input) {
  var str = "";
  var bytes;
  while ((bytes = input.readBytes(1)) != "\n") {
    if (bytes != "\r")
      str += bytes;
  }
  return str;
}

// Bug 1506 P4: Control port interaction. Needed for New Identity.
//
// Executes a command on the control port.
// Return a string response upon success and null upon error.
function torbutton_send_ctrl_cmd(window, command, m_tb_control_pass, m_tb_control_ipc_file, m_tb_control_port,
    m_tb_control_host, m_tb_control_desc) {
  const m_tb_domWindowUtils = window.windowUtils;
  // We spin the event queue until it is empty and we can be sure that sending
  // NEWNYM is not leading to a deadlock (see bug 9531 comment 23 for an
  // invstigation on why and when this may happen). This is surrounded by
  // suppressing/unsuppressing user initiated events in a window's document to
  // be sure that these events are not interfering with processing events being
  // in the event queue.
  var thread = Services.tm.currentThread;
  m_tb_domWindowUtils.suppressEventHandling(true);
  while (thread.processNextEvent(false));
  m_tb_domWindowUtils.suppressEventHandling(false);

  try {
    let sts = Cc["@mozilla.org/network/socket-transport-service;1"]
        .getService(Ci.nsISocketTransportService);
    let socket;
    if (m_tb_control_ipc_file) {
      socket = sts.createUnixDomainTransport(m_tb_control_ipc_file);
    } else {
      socket = sts.createTransport(null, 0, m_tb_control_host,
                                   m_tb_control_port, null);
    }

    // If we don't get a response from the control port in 2 seconds, someting is wrong..
    socket.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, 2);

    var input = socket.openInputStream(3, 1, 1); // 3 == OPEN_BLOCKING|OPEN_UNBUFFERED
    var output = socket.openOutputStream(3, 1, 1); // 3 == OPEN_BLOCKING|OPEN_UNBUFFERED

    var inputStream     = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    var outputStream    = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);

    inputStream.setInputStream(input);
    outputStream.setOutputStream(output);

    var auth_cmd = "AUTHENTICATE " + m_tb_control_pass + "\r\n";
    outputStream.writeBytes(auth_cmd, auth_cmd.length);

    var bytes = torbutton_socket_readline(inputStream);

    if (bytes.indexOf("250") != 0) {
      torbutton_safelog(4, "Unexpected auth response on control port " + m_tb_control_desc + ":", bytes);
      return null;
    }

    outputStream.writeBytes(command, command.length);
    bytes = torbutton_socket_readline(inputStream);
    if (bytes.indexOf("250") != 0) {
      torbutton_safelog(4, "Unexpected command response on control port " + m_tb_control_desc + ":", bytes);
      return null;
    }

    // Closing these streams prevents a shutdown hang on Mac OS. See bug 10201.
    inputStream.close();
    outputStream.close();
    socket.close(Cr.NS_OK);
    return bytes.substr(4);
  } catch (e) {
    torbutton_log(4, "Exception on control port " + e);
    return null;
  }
}

// Export utility functions for external use.
let EXPORTED_SYMBOLS = ["bindPref", "bindPrefAndInit", "getEnv", "getLocale", "getDomainForBrowser",
                        "getPrefValue", "observe", "showDialog", "show_torbrowser_manual", "unescapeTorString",
                        "torbutton_safelog", "torbutton_log", "torbutton_get_property_string",
                        "torbutton_send_ctrl_cmd"];
