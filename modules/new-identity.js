const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { PrivateBrowsingUtils } = ChromeUtils.import("resource://gre/modules/PrivateBrowsingUtils.jsm");
const { torbutton_log, torbutton_get_property_string } =
  ChromeUtils.import("resource://torbutton/modules/utils.js");
let { controller } = ChromeUtils.import("resource://torbutton/modules/tor-control-port.js", {});

// Bug 1506 P4: Used by New Identity if cookie protections are
// not in use.
function torbutton_clear_cookies() {
  torbutton_log(2, "called torbutton_clear_cookies");
  var cm = Services.cookies;

  cm.removeAll();
}

// This function closes all XUL browser windows except this one. For this
// window, it closes all existing tabs and creates one about:blank tab.
function torbutton_close_tabs_on_new_identity(window) {
  if (!Services.prefs.getBoolPref("extensions.torbutton.close_newnym")) {
    torbutton_log(3, "Not closing tabs");
    return;
  }

  // TODO: muck around with browser.tabs.warnOnClose.. maybe..
  torbutton_log(3, "Closing tabs...");
  let wm = Services.wm;
  let enumerator = wm.getEnumerator("navigator:browser");
  let windowsToClose = [];
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    let browser = win.gBrowser;
    if (!browser) {
      torbutton_log(5, "No browser for possible closed window");
      continue;
    }

    let tabCount = browser.browsers.length;
    torbutton_log(3, "Tab count for window: " + tabCount);
    let tabsToRemove = [];
    for (let i = 0; i < tabCount; i++) {
      let tab = browser.getTabForBrowser(browser.browsers[i]);
      if (!tab) {
        torbutton_log(5, "No tab for browser");
      } else {
        tabsToRemove.push(tab);
      }
    }

    if (win == window) {
      browser.addWebTab("about:blank");
    } else {
      // It is a bad idea to alter the window list while iterating
      // over it, so add this window to an array and close it later.
      windowsToClose.push(win);
    }

    // Close each tab except the new blank one that we created.
    tabsToRemove.forEach(aTab => browser.removeTab(aTab));
  }

  // Close all XUL windows except this one.
  torbutton_log(2, "Closing windows...");
  windowsToClose.forEach(aWin => aWin.close());

  torbutton_log(3, "Closed all tabs");
}

function torbutton_clear_image_caches() {
  try {
    let imgCache;
    let imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    if (!("getImgCacheForDocument" in imgTools)) {
      // In Firefox 17 and older, there is one global image cache.  Clear it.
      imgCache = Cc["@mozilla.org/image/cache;1"].getService(Ci.imgICache);
      imgCache.clearCache(false); // evict all but chrome cache
    } else {
      // In Firefox 18 and newer, there are two image caches:  one that is
      // used for regular browsing and one that is used for private browsing.

      // Clear the non-private browsing image cache.
      imgCache = imgTools.getImgCacheForDocument(null);
      imgCache.clearCache(false); // evict all but chrome cache

      // Try to clear the private browsing cache.  To do so, we must locate
      // a content document that is contained within a private browsing window.
      let didClearPBCache = false;
      let wm = Services.wm;
      let enumerator = wm.getEnumerator("navigator:browser");
      while (!didClearPBCache && enumerator.hasMoreElements()) {
        let win = enumerator.getNext();
        let browserDoc = win.document.documentElement;
        if (!browserDoc.hasAttribute("privatebrowsingmode"))
          continue;

        let tabbrowser = win.gBrowser;
        if (!tabbrowser)
          continue;

        var tabCount = tabbrowser.browsers.length;
        for (var i = 0; i < tabCount; i++) {
          let doc = tabbrowser.browsers[i].contentDocument;
          if (doc) {
            imgCache = imgTools.getImgCacheForDocument(doc);
            imgCache.clearCache(false); // evict all but chrome cache
            didClearPBCache = true;
            break;
          }
        }
      }
    }
  } catch (e) {
    // FIXME: This can happen in some rare cases involving XULish image data
    // in combination with our image cache isolation patch. Sure isn't
    // a good thing, but it's not really a super-cookie vector either.
    // We should fix it eventually.
    torbutton_log(4, "Exception on image cache clearing: " + e);
  }
}

// -------------- JS/PLUGIN HANDLING CODE ---------------------
// Bug 1506 P3: Defense in depth. Disables JS and events for New Identity.
function torbutton_disable_browser_js(browser) {
  var eventSuppressor = null;

  /* Solution from: https://bugzilla.mozilla.org/show_bug.cgi?id=409737 */
  // XXX: This kills the entire window. We need to redirect
  // focus and inform the user via a lightbox.
  try {
    if (!browser.contentWindow)
      torbutton_log(3, "No content window to disable JS events.");
    else
      eventSuppressor = browser.contentWindow.windowUtils;
  } catch (e) {
    torbutton_log(4, "Failed to disable JS events: " + e);
  }

  if (browser.docShell)
    browser.docShell.allowJavascript = false;

  try {
    // My estimation is that this does not get the inner iframe windows,
    // but that does not matter, because iframes should be destroyed
    // on the next load.
    browser.contentWindow.name = null;
    browser.contentWindow.window.name = null;
  } catch (e) {
    torbutton_log(4, "Failed to reset window.name: " + e);
  }

  if (eventSuppressor)
    eventSuppressor.suppressEventHandling(true);
}

// Bug 1506 P3: The JS-killing bits of this are used by
// New Identity as a defense-in-depth measure.
function torbutton_disable_window_js(win) {
  var browser = win.gBrowser;
  if (!browser) {
    torbutton_log(5, "No browser for plugin window...");
    return;
  }
  var browsers = browser.browsers;
  torbutton_log(1, "Toggle window plugins");

  for (var i = 0; i < browsers.length; ++i) {
    var b = browser.browsers[i];
    if (b && !b.docShell) {
      try {
        if (b.currentURI)
          torbutton_log(5, "DocShell is null for: " + b.currentURI.spec);
        else
          torbutton_log(5, "DocShell is null for unknown URL");
      } catch (e) {
        torbutton_log(5, "DocShell is null for unparsable URL: " + e);
      }
    }
    if (b && b.docShell) {
      torbutton_disable_browser_js(b);

      // kill meta-refresh and existing page loading
      // XXX: Despite having JUST checked b.docShell, it can
      // actually end up NULL here in some cases?
      try {
        if (b.docShell && b.webNavigation)
          b.webNavigation.stop(b.webNavigation.STOP_ALL);
      } catch (e) {
        torbutton_log(4, "DocShell error: " + e);
      }
    }
  }
}

// Bug 1506 P3: The JS-killing bits of this are used by
// New Identity as a defense-in-depth measure.
//
// This is an ugly beast.. But unfortunately it has to be so..
// Looping over all tabs twice is not somethign we wanna do..
function torbutton_disable_all_js() {
  var wm = Services.wm;
  var enumerator = wm.getEnumerator("navigator:browser");
  while (enumerator.hasMoreElements()) {
      var win = enumerator.getNext();
      torbutton_disable_window_js(win);
  }
}

/* The "New Identity" implementation does the following:
 *   1. Disables Javascript and plugins on all tabs
 *   2. Clears state:
 *      a. OCSP
 *      b. Cache + image cache
 *      c. Site-specific zoom
 *      d. Cookies+DOM Storage+safe browsing key
 *      e. google wifi geolocation token
 *      f. http auth
 *      g. SSL Session IDs
 *      h. last open location url
 *      i. clear content prefs
 *      j. permissions
 *      k. site security settings (e.g. HSTS)
 *      l. IndexedDB and asmjscache storage
 *   3. Sends tor the NEWNYM signal to get a new circuit
 *   4. Opens a new window with the default homepage
 *   5. Closes this window
 *
 * XXX: intermediate SSL certificates are not cleared.
 */
// Bug 1506 P4: Needed for New Identity.
async function torbutton_do_new_identity(window, m_tb_control_pass, m_tb_control_ipc_file, m_tb_control_port,
    m_tb_control_host) {
  const m_tb_domWindowUtils = window.windowUtils;

  const m_tb_prefs = Services.prefs;
  var obsSvc = Services.obs;
  torbutton_log(3, "New Identity: Disabling JS");
  torbutton_disable_all_js();

  m_tb_prefs.setBoolPref("browser.zoom.siteSpecific",
                          !m_tb_prefs.getBoolPref("browser.zoom.siteSpecific"));
  m_tb_prefs.setBoolPref("browser.zoom.siteSpecific",
                          !m_tb_prefs.getBoolPref("browser.zoom.siteSpecific"));

  try {
    if (m_tb_prefs.prefHasUserValue("geo.wifi.access_token")) {
      m_tb_prefs.clearUserPref("geo.wifi.access_token");
    }
  } catch (e) {
    torbutton_log(3, "Exception on wifi token clear: " + e);
  }

  try {
    if (m_tb_prefs.prefHasUserValue("general.open_location.last_url")) {
      m_tb_prefs.clearUserPref("general.open_location.last_url");
    }
  } catch (e) {
    torbutton_log(3, "Exception on clearing last opened location: " + e);
  }

  torbutton_log(3, "New Identity: Closing tabs and clearing searchbox");

  torbutton_close_tabs_on_new_identity(window);

  // Bug #10800: Trying to clear search/find can cause exceptions
  // in unknown cases. Just log for now.
  try {
    var searchBar = window.document.getElementById("searchbar");
    if (searchBar)
      searchBar.textbox.reset();
  } catch (e) {
    torbutton_log(5, "New Identity: Exception on clearing search box: " + e);
  }

  try {
    if (window.gFindBarInitialized) {
      var findbox = window.gFindBar.getElement("findbar-textbox");
      findbox.reset();
      window.gFindBar.close();
    }
  } catch (e) {
    torbutton_log(5, "New Identity: Exception on clearing find bar: " + e);
  }

  torbutton_log(3, "New Identity: Emitting Private Browsing Session clear event");
  obsSvc.notifyObservers(null, "browser:purge-session-history");

  torbutton_log(3, "New Identity: Clearing HTTP Auth");

  if (m_tb_prefs.getBoolPref("extensions.torbutton.clear_http_auth")) {
      var auth = Cc["@mozilla.org/network/http-auth-manager;1"].
          getService(Ci.nsIHttpAuthManager);
      auth.clearAll();
  }

  torbutton_log(3, "New Identity: Clearing Crypto Tokens");

  // Clear all crypto auth tokens. This includes calls to PK11_LogoutAll(),
  // nsNSSComponent::LogoutAuthenticatedPK11() and clearing the SSL session
  // cache.
  let sdr = Cc["@mozilla.org/security/sdr;1"].
                        getService(Ci.nsISecretDecoderRing);
  sdr.logoutAndTeardown();

  // This clears the OCSP cache.
  //
  // nsNSSComponent::Observe() watches security.OCSP.enabled, which calls
  // setValidationOptions(), which in turn calls setNonPkixOcspEnabled() which,
  // if security.OCSP.enabled is set to 0, calls CERT_DisableOCSPChecking(),
  // which calls CERT_ClearOCSPCache().
  // See: https://mxr.mozilla.org/comm-esr24/source/mozilla/security/manager/ssl/src/nsNSSComponent.cpp
  var ocsp = m_tb_prefs.getIntPref("security.OCSP.enabled");
  m_tb_prefs.setIntPref("security.OCSP.enabled", 0);
  m_tb_prefs.setIntPref("security.OCSP.enabled", ocsp);

  // This clears the site permissions on Tor Browser
  // XXX: Tie to some kind of disk-ok pref?
  try {
      Services.perms.removeAll();
  } catch (e) {
      // Actually, this catch does not appear to be needed. Leaving it in for
      // safety though.
      torbutton_log(3, "Can't clear permissions: Not Tor Browser: " + e);
  }

    // Clear site security settings
    let sss = Cc["@mozilla.org/ssservice;1"].
      getService(Ci.nsISiteSecurityService);
    sss.clearAll();

  // This clears the undo tab history.
  var tabs = m_tb_prefs.getIntPref("browser.sessionstore.max_tabs_undo");
  m_tb_prefs.setIntPref("browser.sessionstore.max_tabs_undo", 0);
  m_tb_prefs.setIntPref("browser.sessionstore.max_tabs_undo", tabs);

  torbutton_log(3, "New Identity: Clearing Image Cache");
  torbutton_clear_image_caches();

  torbutton_log(3, "New Identity: Clearing Offline Cache");

  try {
    const LoadContextInfo = Services.loadContextInfo;

    for (let contextInfo of [LoadContextInfo.default, LoadContextInfo.private]) {
      let appCacheStorage = Services.cache2.appCacheStorage(contextInfo, null);
      // The following call (asyncEvictStorage) is actually synchronous, either
      // if we have pref "browser.cache.use_new_backend" -> 1 or
      // "browser.cache.use_new_backend_temp" -> true,
      // then we are using the new cache (cache2) which operates synchronously.
      // If we are using the old cache, then the tor-browser.git patch for
      // #5715 also makes this synchronous. So we pass a null callback.
      try {
        appCacheStorage.asyncEvictStorage(null);
      } catch (err) {
        // We ignore "not available" errors because they occur if a cache
        // has not been used, e.g., if no browsing has been done.
        if (err.name !== "NS_ERROR_NOT_AVAILABLE") {
          throw err;
        }
      }
    }
  } catch (e) {
    torbutton_log(5, "Exception on cache clearing: " + e);
    window.alert("Torbutton: Unexpected error during offline cache clearing: " + e);
  }

  torbutton_log(3, "New Identity: Clearing Disk and Memory Caches");

  try {
    Services.cache2.clear();
  } catch (e) {
    torbutton_log(5, "Exception on cache clearing: " + e);
    window.alert("Torbutton: Unexpected error during cache clearing: " + e);
  }

  torbutton_log(3, "New Identity: Clearing storage");

  let orig_quota_test = m_tb_prefs.getBoolPref("dom.quotaManager.testing");
  try {
      // This works only by setting the pref to `true` otherwise we get an
      // exception and nothing is happening.
      m_tb_prefs.setBoolPref("dom.quotaManager.testing", true);
      Services.qms.clear();
  } catch (e) {
      torbutton_log(5, "Exception on storage clearing: " + e);
  } finally {
      m_tb_prefs.setBoolPref("dom.quotaManager.testing", orig_quota_test);
  }

  torbutton_log(3, "New Identity: Clearing Cookies and DOM Storage");

  torbutton_clear_cookies();

  torbutton_log(3, "New Identity: Closing open connections");

  // Clear keep-alive
  obsSvc.notifyObservers(this, "net:prune-all-connections");

  torbutton_log(3, "New Identity: Clearing Content Preferences");

  // XXX: This may not clear zoom site-specific
  // browser.content.full-zoom
  var pbCtxt = PrivateBrowsingUtils.privacyContextFromWindow(window);
  var cps = Cc["@mozilla.org/content-pref/service;1"]
              .getService(Ci.nsIContentPrefService2);
  cps.removeAllDomains(pbCtxt);

  torbutton_log(3, "New Identity: Syncing prefs");

  // Force prefs to be synced to disk
  Services.prefs.savePrefFile(null);

  torbutton_log(3, "New Identity: Clearing permissions");

  let pm = Services.perms;
  pm.removeAll();

  // Clear the domain isolation state.
  torbutton_log(3, "New Identity: Clearing domain isolator");

  let domainIsolator = Cc["@torproject.org/domain-isolator;1"]
      .getService(Ci.nsISupports).wrappedJSObject;
  domainIsolator.clearIsolation();

  torbutton_log(3, "New Identity: Sending NEWNYM");

  // We only support TBB for newnym.
  if (!m_tb_control_pass || (!m_tb_control_ipc_file && !m_tb_control_port)) {
    const warning = torbutton_get_property_string("torbutton.popup.no_newnym");
    torbutton_log(5, "Torbutton cannot safely newnym. It does not have access to the Tor Control Port.");
    window.alert(warning);
  } else {
    let ctrl = controller(m_tb_control_ipc_file, m_tb_control_host, m_tb_control_port, m_tb_control_pass,
      function(err) {
        // An error has occurred.
        torbutton_log(1, err);
        ctrl.close();
      }
    );
    const resp = await ctrl.sendCommand("SIGNAL NEWNYM\r\n");
    ctrl.close();
    if (!resp) {
      const warning = torbutton_get_property_string("torbutton.popup.no_newnym");
      torbutton_log(5, "Torbutton was unable to request a new circuit from Tor");
      window.alert(warning);
    }
  }

  torbutton_log(3, "Ending any remaining private browsing sessions.");
  obsSvc.notifyObservers(null, "last-pb-context-exited");

  torbutton_log(3, "New Identity: Opening a new browser window");

  // Open a new window with the TBB check homepage
  // In Firefox >=19, can pass {private: true} but we do not need it because
  // we have browser.privatebrowsing.autostart = true
  window.OpenBrowserWindow();

  torbutton_log(3, "New identity successful");

  // Run garbage collection and cycle collection after window is gone.
  // This ensures that blob URIs are forgotten.
  window.addEventListener("unload", function(event) {
    torbutton_log(3, "Initiating New Identity GC pass");
    // Clear out potential pending sInterSliceGCTimer:
    m_tb_domWindowUtils.runNextCollectorTimer();

    // Clear out potential pending sICCTimer:
    m_tb_domWindowUtils.runNextCollectorTimer();

    // Schedule a garbage collection in 4000-1000ms...
    m_tb_domWindowUtils.garbageCollect();

    // To ensure the GC runs immediately instead of 4-10s from now, we need
    // to poke it at least 11 times.
    // We need 5 pokes for GC, 1 poke for the interSliceGC, and 5 pokes for CC.
    // See nsJSContext::RunNextCollectorTimer() in
    // https://mxr.mozilla.org/mozilla-central/source/dom/base/nsJSEnvironment.cpp#1970.
    // XXX: We might want to make our own method for immediate full GC...
    for (let poke = 0; poke < 11; poke++) {
      m_tb_domWindowUtils.runNextCollectorTimer();
    }

    // And now, since the GC probably actually ran *after* the CC last time,
    // run the whole thing again.
    m_tb_domWindowUtils.garbageCollect();
    for (let poke = 0; poke < 11; poke++) {
      m_tb_domWindowUtils.runNextCollectorTimer();
    }

    torbutton_log(3, "Completed New Identity GC pass");
  });

  // Close the current window for added safety
  window.close();
}

let EXPORTED_SYMBOLS = ["torbutton_do_new_identity"];
