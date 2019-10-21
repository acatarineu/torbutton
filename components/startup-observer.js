// Bug 1506 P1-3: This code is mostly hackish remnants of session store
// support. There are a couple of observer events that *might* be worth
// listening to. Search for 1506 in the code.

/*************************************************************************
 * Startup observer (JavaScript XPCOM component)
 *
 * Cases tested (each during Tor and Non-Tor, FF4 and FF3.6)
 *    1. Crash
 *    2. Upgrade
 *    3. Fresh install
 *
 *************************************************************************/

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  FileUtils: "resource://gre/modules/FileUtils.jsm",
  FileSource: "resource://gre/modules/L10nRegistry.jsm",
  L10nRegistry: "resource://gre/modules/L10nRegistry.jsm",
});

let NoScriptControl = ChromeUtils.import(
  "resource://torbutton/modules/noscript-control.js",
  {}
);
let SecurityPrefs = ChromeUtils.import(
  "resource://torbutton/modules/security-prefs.js",
  {}
);
let { torbutton_log } = ChromeUtils.import(
  "resource://torbutton/modules/utils.js",
  {}
);

let tlps;
try {
  tlps = Cc["@torproject.org/torlauncher-protocol-service;1"].getService(
    Ci.nsISupports
  ).wrappedJSObject;
} catch (e) {
  torbutton_log(3, "tor launcher failed " + e);
}

// Module specific constants
const kMODULE_NAME = "Startup";
const kMODULE_CONTRACTID = "@torproject.org/startup-observer;1";
const kMODULE_CID = Components.ID("06322def-6fde-4c06-aef6-47ae8e799629");

const k_tb_last_browser_version_pref =
  "extensions.torbutton.lastBrowserVersion";
const k_tb_browser_update_needed_pref = "extensions.torbutton.updateNeeded";
const k_tb_last_update_check_pref = "extensions.torbutton.lastUpdateCheck";
const k_tb_tor_check_failed_topic = "Torbutton:TorCheckFailed";

let m_tb_control_pass;
let m_tb_control_ipc_file;
let m_tb_control_port;
let m_tb_control_host;
let m_tb_control_desc;

// Bug 1506 P4: Control port interaction. Needed for New Identity.
function torbutton_array_to_hexdigits(array) {
  return array
    .map(function(c) {
      return String("0" + c.toString(16)).slice(-2);
    })
    .join("");
}

// Bug 1506 P4: Control port interaction. Needed for New Identity.
function torbutton_read_authentication_cookie(path) {
  var file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  var fileStream = Cc[
    "@mozilla.org/network/file-input-stream;1"
  ].createInstance(Ci.nsIFileInputStream);
  fileStream.init(file, 1, 0, false);
  var binaryStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
    Ci.nsIBinaryInputStream
  );
  binaryStream.setInputStream(fileStream);
  var array = binaryStream.readByteArray(fileStream.available());
  binaryStream.close();
  fileStream.close();
  return torbutton_array_to_hexdigits(array);
}

function torbutton_init() {
  const m_tb_prefs = Services.prefs;
  SecurityPrefs.initialize();

  // Bug 1506 P4: These vars are very important for New Identity
  var environ = Cc["@mozilla.org/process/environment;1"].getService(
    Ci.nsIEnvironment
  );

  if (environ.exists("TOR_CONTROL_PASSWD")) {
    m_tb_control_pass = environ.get("TOR_CONTROL_PASSWD");
  } else if (environ.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
    var cookie_path = environ.get("TOR_CONTROL_COOKIE_AUTH_FILE");
    try {
      if ("" != cookie_path) {
        m_tb_control_pass = torbutton_read_authentication_cookie(cookie_path);
      }
    } catch (e) {
      torbutton_log(4, "unable to read authentication cookie");
    }
  } else {
    try {
      // Try to get password from Tor Launcher.
      m_tb_control_pass = tlps.TorGetPassword(false);
    } catch (e) {}
  }

  // Try to get the control port IPC file (an nsIFile) from Tor Launcher,
  // since Tor Launcher knows how to handle its own preferences and how to
  // resolve relative paths.
  try {
    m_tb_control_ipc_file = tlps.TorGetControlIPCFile();
  } catch (e) {}

  if (m_tb_control_ipc_file) {
    m_tb_control_desc = m_tb_control_ipc_file.path;
  } else {
    if (environ.exists("TOR_CONTROL_PORT")) {
      m_tb_control_port = environ.get("TOR_CONTROL_PORT");
    } else {
      try {
        const kTLControlPortPref = "extensions.torlauncher.control_port";
        m_tb_control_port = m_tb_prefs.getIntPref(kTLControlPortPref);
      } catch (e) {
        // Since we want to disable some features when Tor Launcher is
        // not installed (e.g., New Identity), we do not set a default
        // port value here.
      }
    }

    if (m_tb_control_port) {
      m_tb_control_desc = "" + m_tb_control_port;
    }

    if (environ.exists("TOR_CONTROL_HOST")) {
      m_tb_control_host = environ.get("TOR_CONTROL_HOST");
    } else {
      try {
        const kTLControlHostPref = "extensions.torlauncher.control_host";
        m_tb_control_host = m_tb_prefs.getCharPref(kTLControlHostPref);
      } catch (e) {
        m_tb_control_host = "127.0.0.1";
      }
    }
  }
}

function cleanupCookies() {
  const migratedPref = "extensions.torbutton.cookiejar_migrated";
  if (!Services.prefs.getBoolPref(migratedPref, false)) {
    // Cleanup stored cookie-jar-selector json files
    const profileFolder = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
    for (const file of profileFolder.directoryEntries) {
      if (file.leafName.match(/^(cookies|protected)-.*[.]json$/)) {
        try {
          file.remove(false);
        } catch (e) {}
      }
    }
    Services.prefs.setBoolPref(migratedPref, true);
  }
}

function StartupObserver() {
  this.logger = Cc["@torproject.org/torbutton-logger;1"].getService(
    Ci.nsISupports
  ).wrappedJSObject;
  this._prefs = Services.prefs;
  this.logger.log(3, "Startup Observer created");

  var env = Cc["@mozilla.org/process/environment;1"].getService(
    Ci.nsIEnvironment
  );
  var prefName = "browser.startup.homepage";
  if (env.exists("TOR_DEFAULT_HOMEPAGE")) {
    // if the user has set this value in a previous installation, don't override it
    if (!this._prefs.prefHasUserValue(prefName)) {
      this._prefs.setCharPref(prefName, env.get("TOR_DEFAULT_HOMEPAGE"));
    }
  }

  try {
    this.is_tbb = true;
    this.logger.log(3, "This is a Tor Browser's XPCOM");
  } catch (e) {
    this.logger.log(3, "This is not a Tor Browser's XPCOM");
  }

  try {
    // XXX: We're in a race with HTTPS-Everywhere to update our proxy settings
    // before the initial SSL-Observatory test... If we lose the race, Firefox
    // caches the old proxy settings for check.tp.o somehwere, and it never loads :(
    this.setProxySettings();
  } catch (e) {
    this.logger.log(
      4,
      "Early proxy change failed. Will try again at profile load. Error: " + e
    );
  }

  cleanupCookies();

  // Using all possible locales so that we do not have to change this list every time we support
  // a new one.
  const allLocales = [
    "en-US",
    "ach",
    "af",
    "an",
    "ar",
    "ast",
    "az",
    "be",
    "bg",
    "bn",
    "br",
    "bs",
    "ca",
    "cak",
    "crh",
    "cs",
    "cy",
    "da",
    "de",
    "dsb",
    "el",
    "en-CA",
    "en-GB",
    "eo",
    "es-AR",
    "es-CL",
    "es-ES",
    "es-MX",
    "et",
    "eu",
    "fa",
    "ff",
    "fi",
    "fr",
    "fy-NL",
    "ga-IE",
    "gd",
    "gl",
    "gn",
    "gu-IN",
    "he",
    "hi-IN",
    "hr",
    "hsb",
    "hu",
    "hy-AM",
    "ia",
    "id",
    "is",
    "it",
    "ja",
    "ja-JP-mac",
    "ka",
    "kab",
    "kk",
    "km",
    "kn",
    "ko",
    "lij",
    "lo",
    "lt",
    "ltg",
    "lv",
    "mk",
    "mr",
    "ms",
    "my",
    "nb-NO",
    "ne-NP",
    "nl",
    "nn-NO",
    "oc",
    "pa-IN",
    "pl",
    "pt-BR",
    "pt-PT",
    "rm",
    "ro",
    "ru",
    "si",
    "sk",
    "sl",
    "son",
    "sq",
    "sr",
    "sv-SE",
    "ta",
    "te",
    "th",
    "tl",
    "tr",
    "trs",
    "uk",
    "ur",
    "uz",
    "vi",
    "wo",
    "xh",
    "zh-CN",
    "zh-TW",
  ];
  let torSource = new FileSource(
    "torbutton",
    allLocales,
    "resource://torbutton/locale/{locale}/",
    true // skip this FileSource locales when computing Services.locale.availableLocales
  );
  L10nRegistry.registerSource(torSource);
}

StartupObserver.prototype = {
  // Bug 6803: We need to get the env vars early due to
  // some weird proxy caching code that showed up in FF15.
  // Otherwise, homepage domain loads fail forever.
  setProxySettings() {
    if (!this.is_tbb) {
      return;
    }

    // Bug 1506: Still want to get these env vars
    let environ = Cc["@mozilla.org/process/environment;1"].getService(
      Ci.nsIEnvironment
    );
    if (environ.exists("TOR_TRANSPROXY")) {
      this.logger.log(3, "Resetting Tor settings to transproxy");
      this._prefs.setBoolPref("network.proxy.socks_remote_dns", false);
      this._prefs.setIntPref("network.proxy.type", 0);
      this._prefs.setIntPref("network.proxy.socks_port", 0);
      this._prefs.setCharPref("network.proxy.socks", "");
    } else {
      // Try to retrieve SOCKS proxy settings from Tor Launcher.
      let socksPortInfo;
      try {
        socksPortInfo = tlps.TorGetSOCKSPortInfo();
      } catch (e) {
        this.logger.log(3, "tor launcher failed " + e);
      }

      // If Tor Launcher is not available, check environment variables.
      if (!socksPortInfo) {
        socksPortInfo = { ipcFile: undefined, host: undefined, port: 0 };

        let isWindows = Services.appinfo.OS === "WINNT";
        if (!isWindows && environ.exists("TOR_SOCKS_IPC_PATH")) {
          socksPortInfo.ipcFile = new FileUtils.File(
            environ.get("TOR_SOCKS_IPC_PATH")
          );
        } else {
          if (environ.exists("TOR_SOCKS_HOST")) {
            socksPortInfo.host = environ.get("TOR_SOCKS_HOST");
          }
          if (environ.exists("TOR_SOCKS_PORT")) {
            socksPortInfo.port = parseInt(environ.get("TOR_SOCKS_PORT"));
          }
        }
      }

      // Adjust network.proxy prefs.
      if (socksPortInfo.ipcFile) {
        let fph = Services.io
          .getProtocolHandler("file")
          .QueryInterface(Ci.nsIFileProtocolHandler);
        let fileURI = fph.newFileURI(socksPortInfo.ipcFile);
        this.logger.log(3, "Reset socks to " + fileURI.spec);
        this._prefs.setCharPref("network.proxy.socks", fileURI.spec);
        this._prefs.setIntPref("network.proxy.socks_port", 0);
      } else {
        if (socksPortInfo.host) {
          this._prefs.setCharPref("network.proxy.socks", socksPortInfo.host);
          this.logger.log(3, "Reset socks host to " + socksPortInfo.host);
        }
        if (socksPortInfo.port) {
          this._prefs.setIntPref(
            "network.proxy.socks_port",
            socksPortInfo.port
          );
          this.logger.log(3, "Reset socks port to " + socksPortInfo.port);
        }
      }

      if (socksPortInfo.ipcFile || socksPortInfo.host || socksPortInfo.port) {
        this._prefs.setBoolPref("network.proxy.socks_remote_dns", true);
        this._prefs.setIntPref("network.proxy.type", 1);
      }
    }

    // Force prefs to be synced to disk
    Services.prefs.savePrefFile(null);

    this.logger.log(3, "Synced network settings to environment.");
  },

  observe(subject, topic, data) {
    if (topic == "profile-after-change") {
      // Bug 1506 P1: We listen to these prefs as signals for startup,
      // but only for hackish reasons.
      this._prefs.setBoolPref("extensions.torbutton.startup", true);

      // We need to listen for NoScript before it starts.
      NoScriptControl.initialize();

      this.setProxySettings();

      torbutton_init();
    }

    // In all cases, force prefs to be synced to disk
    Services.prefs.savePrefFile(null);
  },

  QueryInterface: ChromeUtils.generateQI([Ci.nsIClassInfo]),

  // method of nsIClassInfo
  classDescription: "Torbutton Startup Observer",
  classID: kMODULE_CID,
  contractID: kMODULE_CONTRACTID,

  // Hack to get us registered early to observe recovery
  _xpcom_categories: [{ category: "profile-after-change" }],

  TorGetControlParams() {
    return {
      m_tb_control_pass,
      m_tb_control_ipc_file,
      m_tb_control_port,
      m_tb_control_host,
      m_tb_control_desc,
    };
  },
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([StartupObserver]);
