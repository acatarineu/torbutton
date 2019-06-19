// window globals
var torbutton_init;
var torbutton_new_circuit;
var torbutton_new_identity;

(() => {
// Bug 1506 P1-P5: This is the main Torbutton overlay file. Much needs to be
// preserved here, but in an ideal world, most of this code should perhaps be
// moved into an XPCOM service, and much can also be tossed. See also
// individual 1506 comments for details.

// TODO: check for leaks: http://www.mozilla.org/scriptable/avoiding-leaks.html
// TODO: Double-check there are no strange exploits to defeat:
//       http://kb.mozillazine.org/Links_to_local_pages_don%27t_work

/* global , gBrowser, CustomizableUI,
   createTorCircuitDisplay, gFindBarInitialized,
   gFindBar, OpenBrowserWindow, PrivateBrowsingUtils,
   Services, AppConstants
 */

let {
  show_torbrowser_manual,
  unescapeTorString,
  bindPrefAndInit,
  getDomainForBrowser,
  torbutton_send_ctrl_cmd,
  torbutton_log,
  torbutton_get_property_string,
} = ChromeUtils.import("resource://torbutton/modules/utils.js", {});
let SecurityPrefs = ChromeUtils.import("resource://torbutton/modules/security-prefs.js", {});
let { torbutton_do_new_identity } = ChromeUtils.import("resource://torbutton/modules/new-identity.js", {});

const k_tb_last_browser_version_pref = "extensions.torbutton.lastBrowserVersion";
const k_tb_browser_update_needed_pref = "extensions.torbutton.updateNeeded";
const k_tb_last_update_check_pref = "extensions.torbutton.lastUpdateCheck";
const k_tb_tor_check_failed_topic = "Torbutton:TorCheckFailed";

var m_tb_prefs = Services.prefs;

// status
var m_tb_wasinited = false;
var m_tb_is_main_window = false;

var m_tb_confirming_plugins = false;

var m_tb_control_ipc_file = null;    // Set if using IPC (UNIX domain socket).
var m_tb_control_port = null;        // Set if using TCP.
var m_tb_control_host = null;        // Set if using TCP.
var m_tb_control_pass = null;
var m_tb_control_desc = null;        // For logging.

// Bug 1506 P1: This object is only for updating the UI for toggling and style
var torbutton_window_pref_observer =
{
    register: function()
    {
        m_tb_prefs.addObserver("extensions.torbutton", this, false);
    },

    unregister: function()
    {
        m_tb_prefs.removeObserver("extensions.torbutton", this);
    },

    // topic:   what event occurred
    // subject: what nsIPrefBranch we're observing
    // data:    which pref has been changed (relative to subject)
    observe: function(subject, topic, data)
    {
        if (topic != "nsPref:changed") return;
        switch (data) {
            case k_tb_browser_update_needed_pref:
                torbutton_notify_if_update_needed();
                break;
        }
    }
}

// Bug 1506 P2: This object keeps Firefox prefs in sync with Torbutton prefs.
// It probably could stand some simplification (See #3100). It also belongs
// in a component, not the XUL overlay.
var torbutton_unique_pref_observer =
{
    register: function()
    {
        this.forced_ua = false;
        m_tb_prefs.addObserver("extensions.torbutton", this, false);
        m_tb_prefs.addObserver("browser.privatebrowsing.autostart", this, false);
        m_tb_prefs.addObserver("javascript", this, false);
        m_tb_prefs.addObserver("plugin.disable", this, false);

        // We observe xpcom-category-entry-added for plugins w/ Gecko-Content-Viewers
        var observerService = Services.obs;
        observerService.addObserver(this, "xpcom-category-entry-added");
    },

    unregister: function()
    {
        m_tb_prefs.removeObserver("extensions.torbutton", this);
        m_tb_prefs.removeObserver("browser.privatebrowsing.autostart", this);
        m_tb_prefs.removeObserver("javascript", this);
        m_tb_prefs.removeObserver("plugin.disable", this);

        var observerService = Services.obs;
        observerService.removeObserver(this, "xpcom-category-entry-added");
    },

    // topic:   what event occurred
    // subject: what nsIPrefBranch we're observing
    // data:    which pref has been changed (relative to subject)
    observe: function(subject, topic, data)
    {
        if (topic == "xpcom-category-entry-added") {
          // Hrmm. should we inspect subject too? it's just mime type..
          subject.QueryInterface(Ci.nsISupportsCString);
          if (data == "Gecko-Content-Viewers" &&
              !m_tb_prefs.getBoolPref("extensions.torbutton.startup") &&
              m_tb_prefs.getBoolPref("extensions.torbutton.confirm_plugins")) {
             torbutton_log(3, "Got plugin enabled notification: "+subject);

             /* We need to protect this call with a flag becuase we can
              * get multiple observer events for each mime type a plugin
              * registers. Thankfully, these notifications arrive only on
              * the main thread, *however*, our confirmation dialog suspends
              * execution and allows more events to arrive until it is answered
              */
             if (!m_tb_confirming_plugins) {
               m_tb_confirming_plugins = true;
               torbutton_confirm_plugins();
               m_tb_confirming_plugins = false;
             } else {
               torbutton_log(3, "Skipping notification for mime type: "+subject);
             }
          }
          return;
        }

        if (topic != "nsPref:changed") return;

        switch (data) {
            case "plugin.disable":
                torbutton_toggle_plugins(
                        m_tb_prefs.getBoolPref("plugin.disable"));
                break;
            case "browser.privatebrowsing.autostart":
                torbutton_update_disk_prefs();
                break;
            case "extensions.torbutton.use_nontor_proxy":
                torbutton_use_nontor_proxy();
                break;
        }
    }
}

var torbutton_tor_check_observer = {
    register() {
        this._obsSvc = Services.obs;
        this._obsSvc.addObserver(this, k_tb_tor_check_failed_topic);
    },

    unregister: function()
    {
        if (this._obsSvc)
          this._obsSvc.removeObserver(this, k_tb_tor_check_failed_topic);
    },

    observe: function(subject, topic, data)
    {
      if (topic == k_tb_tor_check_failed_topic) {
        // Update toolbar icon and tooltip.
        torbutton_update_toolbutton();

        // Update all open about:tor pages.
        torbutton_abouttor_message_handler.updateAllOpenPages();

        // If the user does not have an about:tor tab open in the front most
        // window, open one.
        var wm = Services.wm;
        var win = wm.getMostRecentWindow("navigator:browser");
        if (win == window) {
          let foundTab = false;
          let tabBrowser = top.gBrowser;
          for (let i = 0; !foundTab && (i < tabBrowser.browsers.length); ++i) {
            let b = tabBrowser.getBrowserAtIndex(i);
            foundTab = (b.currentURI.spec.toLowerCase() == "about:tor");
          }

          if (!foundTab) {
            gBrowser.selectedTab = gBrowser.addTrustedTab("about:tor");
          }
        }
      }
    },
};

function torbutton_init_toolbutton()
{
    try {
      torbutton_log(3, "Initializing the Torbutton button.");
      torbutton_update_toolbutton();
    } catch(e) {
      torbutton_log(4, "Error Initializing Torbutton button: "+e);
    }
}

function torbutton_is_mobile() {
    return Services.appinfo.OS === "Android";
}

// Bug 1506 P2-P4: This code sets some version variables that are irrelevant.
// It does read out some important environment variables, though. It is
// called once per browser window.. This might belong in a component.
torbutton_init = function() {
    torbutton_log(3, 'called init()');

    SecurityPrefs.initialize();

    if (m_tb_wasinited) {
        return;
    }
    m_tb_wasinited = true;

    // Determine if we are running inside Tor Browser.
    var cur_version;
    try {
      cur_version = m_tb_prefs.getCharPref("torbrowser.version");
      torbutton_log(3, "This is a Tor Browser");
    } catch(e) {
      torbutton_log(3, "This is not a Tor Browser: "+e);
    }

    // If the Tor Browser version has changed since the last time Torbutton
    // was loaded, reset the version check preferences in order to avoid
    // incorrectly reporting that the browser needs to be updated.
    var last_version;
    try {
      last_version = m_tb_prefs.getCharPref(k_tb_last_browser_version_pref);
    } catch (e) {}
    if (cur_version != last_version) {
      m_tb_prefs.setBoolPref(k_tb_browser_update_needed_pref, false);
      if (m_tb_prefs.prefHasUserValue(k_tb_last_update_check_pref)) {
        m_tb_prefs.clearUserPref(k_tb_last_update_check_pref);
      }

      if (cur_version)
        m_tb_prefs.setCharPref(k_tb_last_browser_version_pref, cur_version);
    }

    let tlps;
    try {
        tlps = Cc["@torproject.org/torlauncher-protocol-service;1"]
                 .getService(Ci.nsISupports).wrappedJSObject;
    } catch(e) {}

    // Bug 1506 P4: These vars are very important for New Identity
    var environ = Cc["@mozilla.org/process/environment;1"]
                   .getService(Ci.nsIEnvironment);

    if (environ.exists("TOR_CONTROL_PASSWD")) {
        m_tb_control_pass = environ.get("TOR_CONTROL_PASSWD");
    } else if (environ.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
        var cookie_path = environ.get("TOR_CONTROL_COOKIE_AUTH_FILE");
        try {
            if ("" != cookie_path) {
                m_tb_control_pass = torbutton_read_authentication_cookie(cookie_path);
            }
        } catch(e) {
            torbutton_log(4, 'unable to read authentication cookie');
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
    } catch(e) {}

    if (m_tb_control_ipc_file) {
        m_tb_control_desc = m_tb_control_ipc_file.path;
    } else {
        if (environ.exists("TOR_CONTROL_PORT")) {
            m_tb_control_port = environ.get("TOR_CONTROL_PORT");
        } else {
            try {
                const kTLControlPortPref = "extensions.torlauncher.control_port";
                m_tb_control_port = m_tb_prefs.getIntPref(kTLControlPortPref);
            } catch(e) {
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
            } catch(e) {
              m_tb_control_host = "127.0.0.1";
            }
        }
    }

    // Add about:tor IPC message listener.
    window.messageManager.addMessageListener("AboutTor:Loaded",
                                   torbutton_abouttor_message_handler);

    setupPreferencesForMobile();

    // XXX: Get rid of the cached asmjs (or IndexedDB) files on disk in case we
    // don't allow things saved to disk. This is an ad-hoc fix to work around
    // #19417. Once this is properly solved we should remove this code again.
    if (m_tb_prefs.getBoolPref("browser.privatebrowsing.autostart")) {
      let orig_quota_test = m_tb_prefs.getBoolPref("dom.quotaManager.testing");
      try {
        // This works only by setting the pref to `true` otherwise we get an
        // exception and nothing is happening.
        m_tb_prefs.setBoolPref("dom.quotaManager.testing", true);
        Services.qms.clear();
      } catch (e) {
      } finally {
        m_tb_prefs.setBoolPref("dom.quotaManager.testing", orig_quota_test);
      }
    }

    // listen for our toolbar button being added so we can initialize it
    torbutton_init_toolbutton();

    torbutton_log(1, 'registering pref observer');
    torbutton_window_pref_observer.register();

    torbutton_log(1, "registering Tor check observer");
    torbutton_tor_check_observer.register();

    // Add torbutton and security level buttons to the bar.
    // This should maybe be in the startup function, but we want to add
    // the button to the panel before it's state (color) is set..
    let insertedButton = m_tb_prefs.getBoolPref("extensions.torbutton.inserted_button");
    let insertedSecurityLevel = m_tb_prefs.getBoolPref("extensions.torbutton.inserted_security_level");
    if (!insertedButton || !insertedSecurityLevel) {
      try {
        // ESR31-style toolbar is handled by the existing compiled-in pref.
        // We also need to prevent first-run toolbar reorg (#13378), so we
        // reset this toolbar state on first-run.
        try {
          // get serialized toolbar state
          let uiCustomizationStateJSON = m_tb_prefs.getStringPref("browser.uiCustomization.state");
          let uiCustomizationState = JSON.parse(uiCustomizationStateJSON);

          let placeButtonAfterUrlbar = function(navBar, buttonId) {
            torbutton_log(3, 'placing ' + buttonId);
            // try and remove button if it's present
            let buttonIndex = navBar.indexOf(buttonId);
            if (buttonIndex != -1) {
              navBar.splice(buttonIndex, 1);
            }
            // if urlbar isn't present (which *shouldn't* be possible),
            // inserts button at the beginning of the toolbar (since urlbarIndex will be -1)
            let urlbarIndex = navBar.indexOf("urlbar-container");
            buttonIndex = urlbarIndex + 1;
            navBar.splice(buttonIndex, 0, buttonId);
          };

          // array of navbar elements
          let navBar = uiCustomizationState["placements"]["nav-bar"];
          placeButtonAfterUrlbar(navBar, "security-level-button");
          placeButtonAfterUrlbar(navBar, "torbutton-button");

          // serialize back into pref
          uiCustomizationStateJSON = JSON.stringify(uiCustomizationState, null, 0);
          m_tb_prefs.setStringPref("browser.uiCustomization.state", uiCustomizationStateJSON);
        } catch(e) {
          torbutton_log(4, 'error updating toolbar, reverting to default : ' + e);
          // reverts the serialized toolbar state to default set in Tor Browser
          m_tb_prefs.clearUserPref("browser.uiCustomization.state");
        }
        // reverts toolbar state to firefox defaults
        CustomizableUI.reset();
        // 'restores' toolbar state from serialized state in "browser.uiCustomization.state"
        CustomizableUI.undoReset();
        torbutton_log(3, 'toolbar updated');
        m_tb_prefs.setBoolPref("extensions.torbutton.inserted_button", true);
        m_tb_prefs.setBoolPref("extensions.torbutton.inserted_security_level", true);
      } catch(e) {
        torbutton_log(4, 'failed to update the toolbar : ' + e);
      }
    }

    torbutton_update_toolbutton();
    torbutton_notify_if_update_needed();

    try {
        createTorCircuitDisplay(m_tb_control_ipc_file, m_tb_control_host,
                                m_tb_control_port, m_tb_control_pass,
                               "extensions.torbutton.display_circuit");
    } catch(e) {
        torbutton_log(4, "Error creating the tor circuit display " + e);
    }

    try {
        torbutton_init_user_manual_links();
    } catch(e) {
        torbutton_log(4, "Error loading the user manual " + e);
    }

    // Arrange for our about:tor content script to be loaded in each frame.
    window.messageManager.loadFrameScript(
              "chrome://torbutton/content/aboutTor/aboutTor-content.js", true);

    torbutton_log(3, 'init completed');
}

var torbutton_abouttor_message_handler = {
  // Receive IPC messages from the about:tor content script.
  receiveMessage: function(aMessage) {
    switch(aMessage.name) {
      case "AboutTor:Loaded":
        aMessage.target.messageManager.sendAsyncMessage("AboutTor:ChromeData",
                                                    this.getChromeData(true));
        break;
    }
  },

  // Send privileged data to all of the about:tor content scripts.
  updateAllOpenPages: function() {
    window.messageManager.broadcastAsyncMessage("AboutTor:ChromeData",
                                                this.getChromeData(false));
  },

  // The chrome data contains all of the data needed by the about:tor
  // content process that is only available here (in the chrome process).
  // It is sent to the content process when an about:tor window is opened
  // and in response to events such as the browser noticing that Tor is
  // not working.
  getChromeData: function(aIsRespondingToPageLoad) {
    let dataObj = {
      mobile: torbutton_is_mobile(),
      updateChannel: AppConstants.MOZ_UPDATE_CHANNEL,
      torOn: torbutton_tor_check_ok()
    };

    if (aIsRespondingToPageLoad) {
      const kShouldNotifyPref = "torbrowser.post_update.shouldNotify";
      if (m_tb_prefs.getBoolPref(kShouldNotifyPref, false)) {
        m_tb_prefs.clearUserPref(kShouldNotifyPref);
        dataObj.hasBeenUpdated = true;
        dataObj.updateMoreInfoURL = this.getUpdateMoreInfoURL();
      }
    }

    return dataObj;
  },

  getUpdateMoreInfoURL: function() {
    try {
      return Services.prefs.getCharPref("torbrowser.post_update.url");
    } catch (e) {}

    // Use the default URL as a fallback.
    return Services.urlFormatter.formatURLPref("startup.homepage_override_url");
  }
};

function torbutton_confirm_plugins() {
  var any_plugins_enabled = false;
  var PH=Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost);
  var P=PH.getPluginTags({});
  for(var i=0; i<P.length; i++) {
      if (!P[i].disabled)
        any_plugins_enabled = true;
  }

  if (!any_plugins_enabled) {
    torbutton_log(3, "False positive on plugin notification. Ignoring");
    return;
  }

  torbutton_log(3, "Confirming plugin usage.");

  var prompts = Services.prompt;

  // Display two buttons, both with string titles.
  var flags = prompts.STD_YES_NO_BUTTONS + prompts.BUTTON_DELAY_ENABLE;

  var message = torbutton_get_property_string("torbutton.popup.confirm_plugins");
  var askAgainText = torbutton_get_property_string("torbutton.popup.never_ask_again");
  var askAgain = {value: false};

  var wm = Services.wm;
  var win = wm.getMostRecentWindow("navigator:browser");
  var no_plugins = (prompts.confirmEx(win, "", message, flags, null, null, null,
      askAgainText, askAgain) == 1);

  m_tb_prefs.setBoolPref("extensions.torbutton.confirm_plugins", !askAgain.value);

  // The pref observer for "plugin.disable" will set the appropriate plugin state.
  // So, we only touch the pref if it has changed.
  if (no_plugins !=
      m_tb_prefs.getBoolPref("plugin.disable"))
    m_tb_prefs.setBoolPref("plugin.disable", no_plugins);
  else
    torbutton_toggle_plugins(no_plugins);

  // Now, if any tabs were open to about:addons, reload them. Our popup
  // messed up that page.
  var browserEnumerator = wm.getEnumerator("navigator:browser");

  // Check each browser instance for our URL
  while (browserEnumerator.hasMoreElements()) {
    var browserWin = browserEnumerator.getNext();
    var tabbrowser = browserWin.gBrowser;

    // Check each tab of this browser instance
    var numTabs = tabbrowser.browsers.length;
    for (var index = 0; index < numTabs; index++) {
      var currentBrowser = tabbrowser.getBrowserAtIndex(index);
      if ("about:addons" == currentBrowser.currentURI.spec) {
        torbutton_log(3, "Got browser: "+currentBrowser.currentURI.spec);
        currentBrowser.reload();
      }
    }
  }
}

// Bug 1506 P2: It might be nice to let people move the button around, I guess?
function torbutton_get_toolbutton() {
    var o_toolbutton = false;

    torbutton_log(1, 'get_toolbutton(): looking for button element');
    if (document.getElementById("torbutton-button")) {
        o_toolbutton = document.getElementById("torbutton-button");
    } else if (document.getElementById("torbutton-button-tb")) {
        o_toolbutton = document.getElementById("torbutton-button-tb");
    } else if (document.getElementById("torbutton-button-tb-msg")) {
        o_toolbutton = document.getElementById("torbutton-button-tb-msg");
    } else {
        torbutton_log(3, 'get_toolbutton(): did not find torbutton-button');
    }

    return o_toolbutton;
}

function torbutton_update_is_needed() {
    var updateNeeded = false;
    try {
        updateNeeded = m_tb_prefs.getBoolPref(k_tb_browser_update_needed_pref);
    } catch (e) {}

    return updateNeeded;
}

function torbutton_notify_if_update_needed() {
    function setOrClearAttribute(aElement, aAttrName, aValue)
    {
        if (!aElement || !aAttrName)
            return;

        if (aValue)
            aElement.setAttribute(aAttrName, aValue);
        else
            aElement.removeAttribute(aAttrName);
    }

    let updateNeeded = torbutton_update_is_needed();

    // Change look of toolbar item (enable/disable animated update icon).
    var btn = torbutton_get_toolbutton();
    setOrClearAttribute(btn, "tbUpdateNeeded", updateNeeded);

    // Make the "check for update" menu item bold if an update is needed.
    var item = document.getElementById("torbutton-checkForUpdate");
    setOrClearAttribute(item, "tbUpdateNeeded", updateNeeded);
}

// Bug 1506 P4: Checking for Tor Browser updates is pretty important,
// probably even as a fallback if we ever do get a working updater.
function torbutton_do_async_versioncheck() {
  if (!m_tb_prefs.getBoolPref("extensions.torbutton.versioncheck_enabled")) {
    return;
  }

  // Suppress update check if done recently.
  const kMinSecsBetweenChecks = 120 * 60; // 2.0 hours
  var now = Date.now() / 1000;
  var lastCheckTime;
  try {
    lastCheckTime = parseFloat(m_tb_prefs.getCharPref(k_tb_last_update_check_pref));
    if (isNaN(lastCheckTime))
      lastCheckTime = undefined;
  } catch (e) {}

  if (lastCheckTime && ((now - lastCheckTime) < kMinSecsBetweenChecks))
    return;

  m_tb_prefs.setCharPref(k_tb_last_update_check_pref, now);

  torbutton_log(3, "Checking version with socks port: "
          +m_tb_prefs.getIntPref("network.proxy.socks_port"));
  try {
    var req = new XMLHttpRequest();
    var url = m_tb_prefs.getCharPref("extensions.torbutton.versioncheck_url");
    req.open('GET', url, true);
    req.channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
    req.overrideMimeType("text/json");
    req.onreadystatechange = function (oEvent) {
      if (req.readyState === 4) {
        if(req.status == 200) {
          if(!req.responseText) {
            torbutton_log(5, "Version check failed! No JSON present!");
            return -1;
          }
          try {
            var version_list = JSON.parse(req.responseText);
            var my_version = m_tb_prefs.getCharPref("torbrowser.version");
            var platformSuffix;
            var platform = Services.appinfo.OS;
            switch (platform) {
              case "WINNT":
                platformSuffix = "Windows";
                break;
              case "Darwin":
                platformSuffix = "MacOS";
                break;
              case "Linux":
              case "Android":
                platformSuffix = platform;
                break;
            }
            if (platformSuffix)
              my_version += "-" + platformSuffix;

            if (version_list.indexOf(my_version) >= 0) {
              torbutton_log(3, "Version check passed.");
              m_tb_prefs.setBoolPref(k_tb_browser_update_needed_pref, false);
              return;
            }
            torbutton_log(5, "Your Tor Browser is out of date.");
            m_tb_prefs.setBoolPref(k_tb_browser_update_needed_pref, true);
            return;
          } catch(e) {
            torbutton_log(5, "Version check failed! JSON parsing error: "+e);
            return;
          }
        } else if (req.status == 404) {
          // We're going to assume 404 means the service is not implemented yet.
          torbutton_log(3, "Version check failed. Versions file is 404.");
          return -1;
        }
        torbutton_log(5, "Version check failed! Web server error: "+req.status);
        return -1;
      }
    };
    req.send(null);
  } catch(e) {
    if(e.result == 0x80004005) { // NS_ERROR_FAILURE
      torbutton_log(5, "Version check failed! Is tor running?");
      return -1;
    }
    torbutton_log(5, "Version check failed! Tor internal error: "+e);
    return -1;
  }

}

function torbutton_update_toolbutton()
{
  let o_toolbutton = torbutton_get_toolbutton();
  if (!o_toolbutton) return;

  let isOK = torbutton_tor_check_ok();
  let tbstatus = isOK ? "on" : "off";
  o_toolbutton.setAttribute("tbstatus", tbstatus);

  let tooltipKey = isOK ? "torbutton.panel.label.enabled"
                        : "torbutton.panel.label.disabled";
  o_toolbutton.setAttribute("tooltiptext",
                            torbutton_get_property_string(tooltipKey));
}

// Bug 1506 P4: Control port interaction. Needed for New Identity.
function torbutton_read_authentication_cookie(path) {
  var file = Cc["@mozilla.org/file/local;1"]
             .createInstance(Ci.nsIFile);
  file.initWithPath(path);
  var fileStream = Cc["@mozilla.org/network/file-input-stream;1"]
                   .createInstance(Ci.nsIFileInputStream);
  fileStream.init(file, 1, 0, false);
  var binaryStream = Cc["@mozilla.org/binaryinputstream;1"]
                     .createInstance(Ci.nsIBinaryInputStream);
  binaryStream.setInputStream(fileStream);
  var array = binaryStream.readByteArray(fileStream.available());
  binaryStream.close();
  fileStream.close();
  return torbutton_array_to_hexdigits(array);
}

// Bug 1506 P4: Control port interaction. Needed for New Identity.
function torbutton_array_to_hexdigits(array) {
  return array.map(function(c) {
                     return String("0" + c.toString(16)).slice(-2)
                   }).join('');
};

// Bug 1506 P4: Needed for New IP Address
torbutton_new_circuit = function() {
  let firstPartyDomain = getDomainForBrowser(gBrowser);

  let domainIsolator = Cc["@torproject.org/domain-isolator;1"]
                          .getService(Ci.nsISupports).wrappedJSObject;

  domainIsolator.newCircuitForDomain(firstPartyDomain);

  gBrowser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
}

// Bug 1506 P4: Needed for New Identity.
torbutton_new_identity = function() {
  try {
    // Make sure that we can only click once on New Identiy to avoid race
    // conditions leading to failures (see bug 11783 for an example).
    // TODO: Remove the Torbutton menu entry again once we have done our
    // security control redesign.
    document.getElementById("menu_newIdentity").disabled = true;
    document.getElementById("appMenuNewIdentity").disabled = true;

    let shouldConfirm =  m_tb_prefs.getBoolPref("extensions.torbutton.confirm_newnym");

    if (shouldConfirm) {
      let prompts = Services.prompt;

      // Display two buttons, both with string titles.
      let flags = prompts.STD_YES_NO_BUTTONS;

      let message = torbutton_get_property_string("torbutton.popup.confirm_newnym");
      let askAgainText = torbutton_get_property_string("torbutton.popup.never_ask_again");
      let askAgain = {value: false};

      let confirmed = (prompts.confirmEx(null, "", message, flags, null, null, null,
          askAgainText, askAgain) == 0);

      m_tb_prefs.setBoolPref("extensions.torbutton.confirm_newnym", !askAgain.value);

      if (confirmed) {
        torbutton_do_new_identity(window, m_tb_control_pass, m_tb_control_ipc_file, m_tb_control_port,
          m_tb_control_host, m_tb_control_desc);
      } else {
        // TODO: Remove the Torbutton menu entry again once we have done our
        // security control redesign.
        document.getElementById("menu_newIdentity").disabled = false;
        document.getElementById("appMenuNewIdentity").disabled = false;
      }
    } else {
        torbutton_do_new_identity(window, m_tb_control_pass, m_tb_control_ipc_file, m_tb_control_port,
          m_tb_control_host, m_tb_control_desc);
    }
  } catch(e) {
    // If something went wrong make sure we have the New Identity button
    // enabled (again).
    // TODO: Remove the Torbutton menu entry again once we have done our
    // security control redesign.
    torbutton_log(5, "Unexpected error on new identity: " + e);
    window.alert("Torbutton: Unexpected error on new identity: " + e);
    document.getElementById("menu_newIdentity").disabled = false;
    document.getElementById("appMenuNewIdentity").disabled = false;
  }
}

/* Called when we switch the use_nontor_proxy pref in either direction.
 *
 * Enables/disables domain isolation and then does new identity
 */
function torbutton_use_nontor_proxy()
{
  let domainIsolator = Cc["@torproject.org/domain-isolator;1"]
      .getService(Ci.nsISupports).wrappedJSObject;

  if (m_tb_prefs.getBoolPref("extensions.torbutton.use_nontor_proxy")) {
    // Disable domain isolation
    domainIsolator.disableIsolation();
  } else {
    domainIsolator.enableIsolation();
  }

  // Always reset our identity if the proxy has changed from tor
  // to non-tor.
  torbutton_do_new_identity(window, m_tb_control_pass, m_tb_control_ipc_file, m_tb_control_port,
    m_tb_control_host, m_tb_control_desc);
}

function torbutton_do_tor_check()
{
  let checkSvc = Cc["@torproject.org/torbutton-torCheckService;1"]
                   .getService(Ci.nsISupports).wrappedJSObject;
  if (checkSvc.kCheckNotInitiated != checkSvc.statusOfTorCheck ||
      m_tb_prefs.getBoolPref("extensions.torbutton.use_nontor_proxy") ||
      !m_tb_prefs.getBoolPref("extensions.torbutton.test_enabled"))
    return; // Only do the check once.

  // If we have a tor control port and transparent torification is off,
  // perform a check via the control port.
  const kEnvSkipControlPortTest = "TOR_SKIP_CONTROLPORTTEST";
  const kEnvUseTransparentProxy = "TOR_TRANSPROXY";
  var env = Cc["@mozilla.org/process/environment;1"]
                 .getService(Ci.nsIEnvironment);
  if ((m_tb_control_ipc_file || m_tb_control_port) &&
      !env.exists(kEnvUseTransparentProxy) &&
      !env.exists(kEnvSkipControlPortTest) &&
      m_tb_prefs.getBoolPref("extensions.torbutton.local_tor_check")) {
    if (torbutton_local_tor_check())
      checkSvc.statusOfTorCheck = checkSvc.kCheckSuccessful;
    else {
      // The check failed.  Update toolbar icon and tooltip.
      checkSvc.statusOfTorCheck = checkSvc.kCheckFailed;
      torbutton_update_toolbutton();
    }
  }
  else {
    // A local check is not possible, so perform a remote check.
    torbutton_initiate_remote_tor_check();
  }
}

function torbutton_local_tor_check()
{
  let didLogError = false;

  let proxyType = m_tb_prefs.getIntPref("network.proxy.type");
  if (0 == proxyType)
    return false;

  // Ask tor for its SOCKS listener address and port and compare to the
  // browser preferences.
  const kCmdArg = "net/listeners/socks";
  let resp = torbutton_send_ctrl_cmd(window, "GETINFO " + kCmdArg + "\r\n", m_tb_control_pass,
    m_tb_control_ipc_file, m_tb_control_port, m_tb_control_host, m_tb_control_desc);
  if (!resp)
    return false;

  function logUnexpectedResponse()
  {
    if (!didLogError) {
      didLogError = true;
      torbutton_log(5, "Local Tor check: unexpected GETINFO response: " + resp);
    }
  }

  function removeBrackets(aStr)
  {
    // Remove enclosing square brackets if present.
    if (aStr.startsWith('[') && aStr.endsWith(']'))
      return aStr.substr(1, aStr.length - 2);

    return aStr;
  }

  // Sample response: net/listeners/socks="127.0.0.1:9149" "127.0.0.1:9150"
  // First, check for and remove the command argument prefix.
  if (0 != resp.indexOf(kCmdArg + '=')) {
    logUnexpectedResponse();
    return false;
  }
  resp = resp.substr(kCmdArg.length + 1);

  // Retrieve configured proxy settings and check each listener against them.
  // When the SOCKS prefs are set to use IPC (e.g., a Unix domain socket), a
  // file URL should be present in network.proxy.socks.
  // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1211567
  let socksAddr = m_tb_prefs.getCharPref("network.proxy.socks");
  let socksPort = m_tb_prefs.getIntPref("network.proxy.socks_port");
  let socksIPCPath;
  if (socksAddr && socksAddr.startsWith("file:")) {
    // Convert the file URL to a file path.
    try {
      let ioService = Services.io;
      let fph = ioService.getProtocolHandler("file")
                         .QueryInterface(Ci.nsIFileProtocolHandler);
      socksIPCPath = fph.getFileFromURLSpec(socksAddr).path;
    } catch (e) {
      torbutton_log(5, "Local Tor check: IPC file error: " + e);
      return false;
    }
  } else {
    socksAddr = removeBrackets(socksAddr);
  }

  // Split into quoted strings. This code is adapted from utils.splitAtSpaces()
  // within tor-control-port.js; someday this code should use the entire
  // tor-control-port.js framework.
  let addrArray = [];
  resp.replace(/((\S*?"(.*?)")+\S*|\S+)/g, function (a, captured) {
    addrArray.push(captured);
  });

  let foundSocksListener = false;
  for (let i = 0; !foundSocksListener && (i < addrArray.length); ++i) {
    let addr;
    try { addr = unescapeTorString(addrArray[i]); } catch (e) {}
    if (!addr)
      continue;

    // Remove double quotes if present.
    let len = addr.length;
    if ((len > 2) && ('"' == addr.charAt(0)) && ('"' == addr.charAt(len - 1)))
      addr = addr.substring(1, len - 1);

    if (addr.startsWith("unix:")) {
      if (!socksIPCPath)
        continue;

      // Check against the configured UNIX domain socket proxy.
      let path = addr.substring(5);
      torbutton_log(2, "Tor socks listener (Unix domain socket): " + path);
      foundSocksListener = (socksIPCPath === path);
    } else if (!socksIPCPath) {
      // Check against the configured TCP proxy. We expect addr:port where addr
      // may be an IPv6 address; that is, it may contain colon characters.
      // Also, we remove enclosing square brackets before comparing addresses
      // because tor requires them but Firefox does not.
      let idx = addr.lastIndexOf(':');
      if (idx < 0) {
        logUnexpectedResponse();
      } else {
        let torSocksAddr = removeBrackets(addr.substring(0, idx));
        let torSocksPort = parseInt(addr.substring(idx + 1), 10);
        if ((torSocksAddr.length < 1) || isNaN(torSocksPort)) {
          logUnexpectedResponse();
        } else {
          torbutton_log(2, "Tor socks listener: " + torSocksAddr + ':'
                           + torSocksPort);
          foundSocksListener = ((socksAddr === torSocksAddr) &&
                                (socksPort === torSocksPort));
        }
      }
    }
  }

  return foundSocksListener;
} // torbutton_local_tor_check


function torbutton_initiate_remote_tor_check() {
  let obsSvc = Services.obs;
  try {
      let checkSvc = Cc["@torproject.org/torbutton-torCheckService;1"]
                       .getService(Ci.nsISupports).wrappedJSObject;
      let req = checkSvc.createCheckRequest(true); // async
      req.onreadystatechange = function (aEvent) {
          if (req.readyState === 4) {
            let ret = checkSvc.parseCheckResponse(req);

            // If we received an error response from check.torproject.org,
            // set the status of the tor check to failure (we don't want
            // to indicate failure if we didn't receive a response).
            if (ret == 2 || ret == 3 || ret == 5 || ret == 6
                || ret == 7 || ret == 8) {
              checkSvc.statusOfTorCheck = checkSvc.kCheckFailed;
              obsSvc.notifyObservers(null, k_tb_tor_check_failed_topic, null);
            } else if (ret == 4) {
              checkSvc.statusOfTorCheck = checkSvc.kCheckSuccessful;
            } // Otherwise, redo the check later

            torbutton_log(3, "Tor remote check done. Result: " + ret);
          }
      };

      torbutton_log(3, "Sending async Tor remote check");
      req.send(null);
  } catch(e) {
    if (e.result == 0x80004005) // NS_ERROR_FAILURE
      torbutton_log(5, "Tor check failed! Is tor running?");
    else
      torbutton_log(5, "Tor check failed! Tor internal error: "+e);

    checkSvc.statusOfTorCheck = checkSvc.kCheckFailed;
    obsSvc.notifyObservers(null, k_tb_tor_check_failed_topic, null);
  }
} // torbutton_initiate_remote_tor_check()

function torbutton_tor_check_ok()
{
  let checkSvc = Cc["@torproject.org/torbutton-torCheckService;1"]
                   .getService(Ci.nsISupports).wrappedJSObject;
  return (checkSvc.kCheckFailed != checkSvc.statusOfTorCheck);
}

// Bug 1506 P5: Despite the name, this is the way we disable
// plugins for Tor Browser, too.
//
// toggles plugins: true for disabled, false for enabled
function torbutton_toggle_plugins(disable_plugins) {
  var PH=Cc["@mozilla.org/plugin/host;1"].getService(Ci.nsIPluginHost);
  var P=PH.getPluginTags({});
  for(var i=0; i<P.length; i++) {
      if ("enabledState" in P[i]) { // FF24
        // FIXME: DOCDOC the reasoning for the isDisabled check, or remove it.
        var isDisabled = (P[i].enabledState == Ci.nsIPluginTag.STATE_DISABLED);
        if (!isDisabled && disable_plugins)
          P[i].enabledState = Ci.nsIPluginTag.STATE_DISABLED;
        else if (isDisabled && !disable_plugins)
          P[i].enabledState = Ci.nsIPluginTag.STATE_CLICKTOPLAY;
      } else if (P[i].disabled != disable_plugins) { // FF17
        P[i].disabled=disable_plugins;
      }
  }
}

function torbutton_update_disk_prefs() {
    var mode = m_tb_prefs.getBoolPref("browser.privatebrowsing.autostart");

    m_tb_prefs.setBoolPref("browser.cache.disk.enable", !mode);
    m_tb_prefs.setBoolPref("places.history.enabled", !mode);

    m_tb_prefs.setBoolPref("security.nocertdb", mode);

    // No way to clear this beast during New Identity. Leave it off.
    //m_tb_prefs.setBoolPref("dom.indexedDB.enabled", !mode);

    m_tb_prefs.setBoolPref("permissions.memory_only", mode);

    // Third party abuse. Leave it off for now.
    //m_tb_prefs.setBoolPref("browser.cache.offline.enable", !mode);

    if (mode) {
        m_tb_prefs.setIntPref("network.cookie.lifetimePolicy", 2);
        m_tb_prefs.setIntPref("browser.download.manager.retention", 1);
    } else {
        m_tb_prefs.setIntPref("network.cookie.lifetimePolicy", 0);
        m_tb_prefs.setIntPref("browser.download.manager.retention", 2);
    }

    // Force prefs to be synced to disk
    Services.prefs.savePrefFile(null);
}

// -------------- HISTORY & COOKIES ---------------------

// Bug 1506 P1: This function just cleans up prefs that got set badly in previous releases
function torbutton_fixup_old_prefs()
{
    if(m_tb_prefs.getIntPref('extensions.torbutton.pref_fixup_version') < 1) {
        // TBB 5.0a3 had bad Firefox code that silently flipped this pref on us
        if (m_tb_prefs.prefHasUserValue("browser.newtabpage.enhanced")) {
            m_tb_prefs.clearUserPref("browser.newtabpage.enhanced");
            // TBB 5.0a3 users had all the necessary data cached in
            // directoryLinks.json. This meant that resetting the pref above
            // alone was not sufficient as the tiles features uses the cache
            // even if the pref indicates that feature should be disabled.
            // We flip the preference below as this forces a refetching which
            // effectively results in an empty JSON file due to our spoofed
            // URLs.
            let matchOS = m_tb_prefs.getBoolPref("intl.locale.matchOS");
            m_tb_prefs.setBoolPref("intl.locale.matchOS", !matchOS);
            m_tb_prefs.setBoolPref("intl.locale.matchOS", matchOS);
        }

        // For some reason, the Share This Page button also survived the
        // TBB 5.0a4 update's attempt to remove it.
        if (m_tb_prefs.prefHasUserValue("browser.uiCustomization.state")) {
            m_tb_prefs.clearUserPref("browser.uiCustomization.state");
        }

        m_tb_prefs.setIntPref('extensions.torbutton.pref_fixup_version', 1);
    }
}

// ---------------------- Event handlers -----------------

// Bug 1506 P1-P3: Most of these observers aren't very important.
// See their comments for details
function torbutton_do_main_window_startup()
{
    torbutton_log(3, "Torbutton main window startup");
    m_tb_is_main_window = true;
    torbutton_unique_pref_observer.register();
}

// Bug 1506 P4: Most of this function is now useless, save
// for the very important SOCKS environment vars at the end.
// Those could probably be rolled into a function with the
// control port vars, though. See 1506 comments inside.
function torbutton_do_startup()
{
    if(m_tb_prefs.getBoolPref("extensions.torbutton.startup")) {
        // Bug 1506: Still want to do this
        torbutton_toggle_plugins(
                m_tb_prefs.getBoolPref("plugin.disable"));

        // Bug 1506: Should probably be moved to an XPCOM component
        torbutton_do_main_window_startup();

        // For general pref fixups to handle pref damage in older versions
        torbutton_fixup_old_prefs();

        m_tb_prefs.setBoolPref("extensions.torbutton.startup", false);
    }
}

// Perform version check when a new tab is opened.
function torbutton_new_tab(event)
{
    // listening for new tabs
    torbutton_log(3, "New tab");

    /* Perform the version check on new tab, module timer */
    torbutton_do_async_versioncheck();
}

// Bug 1506 P3: Used to decide if we should resize the window.
//
// Returns true if the window wind is neither maximized, full screen,
// ratpoisioned/evilwmed, nor minimized.
function torbutton_is_windowed(wind) {
    torbutton_log(3, "Window: (" + wind.outerWidth + "," + wind.outerHeight + ") ?= ("
                     + wind.screen.availWidth + "," + wind.screen.availHeight + ")");
    if (wind.windowState == Ci.nsIDOMChromeWindow.STATE_MINIMIZED
      || wind.windowState == Ci.nsIDOMChromeWindow.STATE_MAXIMIZED) {
        torbutton_log(2, "Window is minimized/maximized");
        return false;
    }
    if ("fullScreen" in wind && wind.fullScreen) {
        torbutton_log(2, "Window is fullScreen");
        return false;
    }
    if(wind.outerHeight == wind.screen.availHeight
            && wind.outerWidth == wind.screen.availWidth) {
        torbutton_log(3, "Window is ratpoisoned/evilwm'ed");
        return false;
    }

    torbutton_log(2, "Window is normal");
    return true;
}

function showSecurityPreferencesPanel(chromeWindow) {
  const tabBrowser = chromeWindow.BrowserApp;
  let settingsTab = null;

  const SECURITY_PREFERENCES_URI = 'chrome://torbutton/content/preferences.xhtml';

  tabBrowser.tabs.some(function (tab) {
      // If the security prefs tab is opened, send the user to it
      if (tab.browser.currentURI.spec === SECURITY_PREFERENCES_URI) {
          settingsTab = tab;
          return true;
      }
      return false;
  });

  if (settingsTab === null) {
      // Open up the settings panel in a new tab.
      tabBrowser.addTrustedTab(SECURITY_PREFERENCES_URI, {
          "selected": true,
          "parentId": tabBrowser.selectedTab.id,
      });
  } else {
      // Activate an existing settings panel tab.
      tabBrowser.selectTab(settingsTab);
  }
}

function setupPreferencesForMobile() {
  if (!torbutton_is_mobile()) {
    return;
  }

  torbutton_log(4, "Setting up settings preferences for Android.");

  const chromeWindow = Services.wm.getMostRecentWindow('navigator:browser');

  // Add the extension's chrome menu item to the main browser menu.
  chromeWindow.NativeWindow.menu.add({
    'name': torbutton_get_property_string("torbutton.security_settings.menu.title"),
    'callback': showSecurityPreferencesPanel.bind(this, chromeWindow)
  });
}

// Bug 1506 P3: This is needed pretty much only for the version check
// and the window resizing. See comments for individual functions for
// details
function torbutton_new_window(event)
{
    torbutton_log(3, "New window");
    var browser = window.gBrowser;

    if(!browser) {
      torbutton_log(5, "No browser for new window.");
      return;
    }

    if (!m_tb_wasinited) {
        torbutton_init();
    }
    // Add tab open listener..
    browser.tabContainer.addEventListener("TabOpen", torbutton_new_tab, false);

    torbutton_do_startup();

    let progress = Cc["@mozilla.org/docloaderservice;1"]
                     .getService(Ci.nsIWebProgress);

    if (m_tb_prefs.getBoolPref("privacy.resistFingerprinting")
            && torbutton_is_windowed(window)) {
      progress.addProgressListener(torbutton_resizelistener,
                                   Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
    }

    // Check the version on every new window. We're already pinging check in these cases.
    torbutton_do_async_versioncheck();

    torbutton_do_tor_check();
}

// Bug 1506 P2: This is only needed because we have observers
// in XUL that should be in an XPCOM component
function torbutton_close_window(event) {
    torbutton_window_pref_observer.unregister();
    torbutton_tor_check_observer.unregister();

    window.removeEventListener("sizemodechange", m_tb_resize_handler,
        false);

    // TODO: This is a real ghetto hack.. When the original window
    // closes, we need to find another window to handle observing
    // unique events... The right way to do this is to move the
    // majority of torbutton functionality into a XPCOM component..
    // But that is a major overhaul..
    if (m_tb_is_main_window) {
        torbutton_log(3, "Original window closed. Searching for another");
        var wm = Services.wm;
        var enumerator = wm.getEnumerator("navigator:browser");
        while(enumerator.hasMoreElements()) {
            var win = enumerator.getNext();
            // For some reason, when New Identity is called from a pref
            // observer (ex: torbutton_use_nontor_proxy) on an ASAN build,
            // we sometimes don't have this symbol set in the new window yet.
            // However, the new window will run this init later in that case,
            // as it does in the OSX case.
            if(win != window && "torbutton_do_main_window_startup" in win) {
                torbutton_log(3, "Found another window");
                win.torbutton_do_main_window_startup();
                m_tb_is_main_window = false;
                break;
            }
        }

        torbutton_unique_pref_observer.unregister();

        if(m_tb_is_main_window) { // main window not reset above
            // This happens on Mac OS because they allow firefox
            // to still persist without a navigator window
            torbutton_log(3, "Last window closed. None remain.");
            m_tb_prefs.setBoolPref("extensions.torbutton.startup", true);
            m_tb_is_main_window = false;
        }
    }
}


function torbutton_open_network_settings() {
  var obsSvc = Services.obs;
  obsSvc.notifyObservers(this, "TorOpenNetworkSettings");
}


window.addEventListener('load',torbutton_new_window,false);
window.addEventListener('unload', torbutton_close_window, false);

var m_tb_resize_handler = null;
var m_tb_resize_date = null;

// Bug 1506 P1/P3: Setting a fixed window size is important, but
// probably not for android.
var torbutton_resizelistener =
{
  QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),

  onLocationChange: function(aProgress, aRequest, aURI) {},
  onStateChange: function(aProgress, aRequest, aFlag, aStatus) {
    if (aFlag & Ci.nsIWebProgressListener.STATE_STOP) {
      m_tb_resize_handler = async function() {
        // Wait for end of execution queue to ensure we have correct windowState.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (window.windowState === window.STATE_MAXIMIZED ||
            window.windowState === window.STATE_FULLSCREEN) {
          if (m_tb_prefs.
              getIntPref("extensions.torbutton.maximize_warnings_remaining") > 0) {

            // Do not add another notification if one is already showing.
            const kNotificationName = "torbutton-maximize-notification";
            let box = gBrowser.getNotificationBox();
            if (box.getNotificationWithValue(kNotificationName))
              return;

            // Rate-limit showing our notification if needed.
            if (m_tb_resize_date === null) {
              m_tb_resize_date = Date.now();
            } else {
              // We wait at least another second before we show a new
              // notification. Should be enough to rule out OSes that call our
              // handler rapidly due to internal workings.
              if (Date.now() - m_tb_resize_date < 1000) {
                return;
              }
              // Resizing but we need to reset |m_tb_resize_date| now.
              m_tb_resize_date = Date.now();
            }

            // No need to get "OK" translated again.
            let sbSvc = Services.strings;
            let bundle = sbSvc.
              createBundle("chrome://global/locale/commonDialogs.properties");
            let button_label = bundle.GetStringFromName("OK");

            let buttons = [{
              label: button_label,
              accessKey: 'O',
              popup: null,
              callback:
                function() {
                  m_tb_prefs.setIntPref("extensions.torbutton.maximize_warnings_remaining",
                  m_tb_prefs.getIntPref("extensions.torbutton.maximize_warnings_remaining") - 1);
                }
            }];

            let priority = box.PRIORITY_WARNING_LOW;
            let message =
              torbutton_get_property_string("torbutton.maximize_warning");

            box.appendNotification(message, kNotificationName, null,
                                   priority, buttons);
            return;
          }
        }
      }; // m_tb_resize_handler

      // We need to handle OSes that auto-maximize windows depending on user
      // settings and/or screen resolution in the start-up phase and users that
      // try to shoot themselves in the foot by maximizing the window manually.
      // We add a listener which is triggerred as soon as the window gets
      // maximized (windowState = 1). We are resizing during start-up but not
      // later as the user should see only a warning there as a stopgap before
      // #14229 lands.
      // Alas, the Firefox window code is handling the event not itself:
      // "// Note the current implementation of SetSizeMode just stores
      //  // the new state; it doesn't actually resize. So here we store
      //  // the state and pass the event on to the OS."
      // (See: https://mxr.mozilla.org/mozilla-esr31/source/xpfe/appshell/src/
      // nsWebShellWindow.cpp#348)
      // This means we have to cope with race conditions and resizing in the
      // sizemodechange listener is likely to fail. Thus, we add a specific
      // resize listener that is doing the work for us. It seems (at least on
      // Ubuntu) to be the case that maximizing (and then again normalizing) of
      // the window triggers more than one resize event the first being not the
      // one we need. Thus we can't remove the listener after the first resize
      // event got fired. Thus, we have the rather klunky setTimeout() call.
      window.addEventListener("sizemodechange", m_tb_resize_handler, false);

      let progress = Cc["@mozilla.org/docloaderservice;1"]
                       .getService(Ci.nsIWebProgress);
      progress.removeProgressListener(this);
    }
  }, // onStateChange

  onProgressChange: function(aProgress, aRequest, curSelfProgress,
                             maxSelfProgress, curTotalProgress,
                             maxTotalProgress) {},
  onStatusChange: function(aProgress, aRequest, stat, message) {},
  onSecurityChange: function() {}
};

// Makes sure the item in the Help Menu and the link in about:tor
// for the Tor Browser User Manual are only visible when
// show_torbrowser_manual() returns true.
function torbutton_init_user_manual_links() {
  let menuitem = document.getElementById("torBrowserUserManual");
  bindPrefAndInit("intl.locale.requested", val => {
    menuitem.hidden = !show_torbrowser_manual();
    torbutton_abouttor_message_handler.updateAllOpenPages();
  });
}
})();
//vim:set ts=4
