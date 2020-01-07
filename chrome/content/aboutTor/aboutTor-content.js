/*************************************************************************
 * Copyright (c) 2019, The Tor Project, Inc.
 * See LICENSE for licensing information.
 *
 * vim: set sw=2 sts=2 ts=8 et syntax=javascript:
 *
 * about:tor content script
 *************************************************************************/

/* eslint-env mozilla/frame-script */

/*
 * The following about:tor IPC messages are exchanged by this code and
 * the code in torbutton.js:
 *   AboutTor:Loaded          page loaded            content -> chrome
 *   AboutTor:ChromeData      privileged data        chrome -> content
 */

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

let { bindPrefAndInit, show_torbrowser_manual } = ChromeUtils.import(
  "resource://torbutton/modules/utils.js",
  {}
);

var AboutTorListener = {
  kAboutTorLoadedMessage: "AboutTor:Loaded",
  kAboutTorChromeDataMessage: "AboutTor:ChromeData",

  get isAboutTor() {
    return content.document.documentURI.toLowerCase() == "about:tor";
  },

  init(aChromeGlobal) {
    aChromeGlobal.addEventListener("AboutTorLoad", this, false, true);
  },

  handleEvent(aEvent) {
    if (!this.isAboutTor) {
      return;
    }

    switch (aEvent.type) {
      case "AboutTorLoad":
        this.onPageLoad();
        break;
      case "pagehide":
        this.onPageHide();
        break;
    }
  },

  receiveMessage(aMessage) {
    if (!this.isAboutTor) {
      return;
    }

    switch (aMessage.name) {
      case this.kAboutTorChromeDataMessage:
        this.onChromeDataUpdate(aMessage.data);
        break;
    }
  },

  onPageLoad() {
    // Arrange to update localized text and links.
    bindPrefAndInit("intl.locale.requested", aNewVal => {
      if (aNewVal !== null) {
        this.onLocaleChange(aNewVal);
      }
    });

    // Add message and event listeners.
    addMessageListener(this.kAboutTorChromeDataMessage, this);
    addEventListener("pagehide", this, false);
    addEventListener("resize", this, false);

    sendAsyncMessage(this.kAboutTorLoadedMessage);
  },

  onPageHide() {
    removeEventListener("resize", this, false);
    removeEventListener("pagehide", this, false);
    removeMessageListener(this.kAboutTorChromeDataMessage, this);
  },

  onChromeDataUpdate(aData) {
    let body = content.document.body;

    // Update status: tor on/off, Tor Browser manual shown.
    if (aData.torOn) {
      body.setAttribute("toron", "yes");
    } else {
      body.removeAttribute("toron");
    }

    if (show_torbrowser_manual()) {
      body.setAttribute("showmanual", "yes");
    } else {
      body.removeAttribute("showmanual");
    }

    if (aData.updateChannel) {
      body.setAttribute("updatechannel", aData.updateChannel);
    } else {
      body.removeAttribute("updatechannel");
    }

    if (aData.hasBeenUpdated) {
      body.setAttribute("hasbeenupdated", "yes");
      content.document
        .getElementById("update-infolink")
        .setAttribute("href", aData.updateMoreInfoURL);
    }

    if (aData.mobile) {
      body.setAttribute("mobile", "yes");
    }

    // Setting body.initialized="yes" displays the body.
    body.setAttribute("initialized", "yes");
  },

  onLocaleChange(aLocale) {
    // Set localized Tor Browser manual and "Get Involved" links.
    content.document.getElementById("manualLink").href =
      "https://tb-manual.torproject.org/" + aLocale;
    content.document.getElementById("getInvolvedLink").href =
      "https://community.torproject.org/" + aLocale;

    // Display the Tor Browser product name and version.
    try {
      const kBrandBundle = "chrome://branding/locale/brand.properties";
      let brandBundle = Services.strings.createBundle(kBrandBundle);
      let productName = brandBundle.GetStringFromName("brandFullName");
      let tbbVersion = Services.prefs.getCharPref("torbrowser.version");
      let elem = content.document.getElementById("torbrowser-version");

      while (elem.firstChild) {
        elem.firstChild.remove();
      }
      elem.appendChild(
        content.document.createTextNode(productName + " " + tbbVersion)
      );
    } catch (e) {}
  },
};

AboutTorListener.init(this);
