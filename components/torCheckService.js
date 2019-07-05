/** ***********************************************************************
 * Copyright (c) 2013, The Tor Project, Inc.
 * See LICENSE for licensing information.
 *
 * vim: set sw=2 sts=2 ts=8 et syntax=javascript:
 *
 * Tor check service
 *************************************************************************/

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

let {
  torbutton_log,
  unescapeTorString,
} = ChromeUtils.import("resource://torbutton/modules/utils.js", {});

let { controller } = ChromeUtils.import("resource://torbutton/modules/tor-control-port.js", {});

// Module specific constants
const kMODULE_NAME = "Torbutton Tor Check Service";
const kMODULE_CONTRACTID = "@torproject.org/torbutton-torCheckService;1";
const kMODULE_CID = Components.ID("5d57312b-5d8c-4169-b4af-e80d6a28a72e");
const k_tb_tor_check_failed_topic = "Torbutton:TorCheckFailed";

let startupObs = Cc["@torproject.org/startup-observer;1"]
                   .getService(Ci.nsISupports).wrappedJSObject;
const { m_tb_control_ipc_file, m_tb_control_host,
  m_tb_control_port, m_tb_control_pass } = startupObs.TorGetControlParams();

function TBTorCheckService() {
  torbutton_log(3, "Torbutton Tor Check Service initialized");
  this._statusOfTorCheck = this.kCheckNotInitiated;
  this.wrappedJSObject = this;
}

TBTorCheckService.prototype =
{
  QueryInterface: ChromeUtils.generateQI([Ci.nsIClassInfo]),

  kCheckNotInitiated: 0, // Possible values for statusOfTorCheck.
  kCheckSuccessful: 1,
  kCheckFailed: 2,

  wrappedJSObject: null,
  _statusOfTorCheck: 0, // this.kCheckNotInitiated,

  // make this an nsIClassInfo object
  flags: Ci.nsIClassInfo.DOM_OBJECT,

  // method of nsIClassInfo
  classDescription: kMODULE_NAME,
  classID: kMODULE_CID,
  contractID: kMODULE_CONTRACTID,

  // method of nsIClassInfo
  getInterfaces(count) {
    var interfaceList = [Ci.nsIClassInfo];
    count.value = interfaceList.length;
    return interfaceList;
  },

  // method of nsIClassInfo
  getHelperForLanguage(count) { return null; },

  // Public methods.
  get statusOfTorCheck() {
    return this._statusOfTorCheck;
  },

  set statusOfTorCheck(aStatus) {
    this._statusOfTorCheck = aStatus;
  },

  createCheckRequest(aAsync) {
    let req = new XMLHttpRequest();
    let url = Services.prefs.getCharPref("extensions.torbutton.test_url");
    req.open("GET", url, aAsync);
    req.channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
    req.overrideMimeType("text/xml");
    req.timeout = 120000; // Wait at most two minutes for a response.
    return req;
  },

  parseCheckResponse(aReq) {
    let ret = 0;
    if (aReq.status == 200) {
        if (!aReq.responseXML) {
            torbutton_log(5, "Check failed! Not text/xml!");
            ret = 1;
        } else {
          let result = aReq.responseXML.getElementById("TorCheckResult");

          if (result === null) {
              torbutton_log(5, "Test failed! No TorCheckResult element");
              ret = 2;
          } else if (typeof(result.target) == "undefined"
                  || result.target === null) {
              torbutton_log(5, "Test failed! No target");
              ret = 3;
          } else if (result.target === "success") {
              torbutton_log(3, "Test Successful");
              ret = 4;
          } else if (result.target === "failure") {
              torbutton_log(5, "Tor test failed!");
              ret = 5;
          } else if (result.target === "unknown") {
              torbutton_log(5, "Tor test failed. TorDNSEL Failure?");
              ret = 6;
          } else {
              torbutton_log(5, "Tor test failed. Strange target.");
              ret = 7;
          }
        }
      } else {
        if (0 == aReq.status) {
          try {
            var req = aReq.channel.QueryInterface(Ci.nsIRequest);
            if (req.status == Cr.NS_ERROR_PROXY_CONNECTION_REFUSED) {
              torbutton_log(5, "Tor test failed. Proxy connection refused");
              ret = 8;
            }
          } catch (e) {}
        }

        if (ret == 0) {
          torbutton_log(5, "Tor test failed. HTTP Error: " + aReq.status);
          ret = -aReq.status;
        }
      }

    return ret;
  },
  async torbutton_do_tor_check() {
    if (this.kCheckNotInitiated != this.statusOfTorCheck ||
        Services.prefs.getBoolPref("extensions.torbutton.use_nontor_proxy") ||
        !Services.prefs.getBoolPref("extensions.torbutton.test_enabled"))
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
        Services.prefs.getBoolPref("extensions.torbutton.local_tor_check")) {
      if (await this.torbutton_local_tor_check()) {
        this.statusOfTorCheck = this.kCheckSuccessful;
      } else {
        // The check failed.  Update toolbar icon and tooltip.
        this.statusOfTorCheck = this.kCheckFailed;
      }
    } else {
      // A local check is not possible, so perform a remote check.
      this.torbutton_initiate_remote_tor_check();
    }
  },
  torbutton_initiate_remote_tor_check() {
    let obsSvc = Services.obs;
    try {
        let req = this.createCheckRequest(true); // async
        req.onreadystatechange = (aEvent) => {
            if (req.readyState === 4) {
              let ret = this.parseCheckResponse(req);
              // If we received an error response from check.torproject.org,
              // set the status of the tor check to failure (we don't want
              // to indicate failure if we didn't receive a response).
              if (ret == 2 || ret == 3 || ret == 5 || ret == 6
                  || ret == 7 || ret == 8) {
                    this.statusOfTorCheck = this.kCheckFailed;
                obsSvc.notifyObservers(null, k_tb_tor_check_failed_topic);
              } else if (ret == 4) {
                this.statusOfTorCheck = this.kCheckSuccessful;
              } // Otherwise, redo the check later
              torbutton_log(3, "Tor remote check done. Result: " + ret);
            }
        };

        torbutton_log(3, "Sending async Tor remote check");
        req.send(null);
    } catch (e) {
      if (e.result == 0x80004005) { // NS_ERROR_FAILURE
        torbutton_log(5, "Tor check failed! Is tor running?");
      } else {
        torbutton_log(5, "Tor check failed! Tor internal error: " + e);
      }
      this.statusOfTorCheck = this.kCheckFailed;
      obsSvc.notifyObservers(null, k_tb_tor_check_failed_topic);
    }
  },
  async torbutton_local_tor_check() {
    let didLogError = false;

    let proxyType = Services.prefs.getIntPref("network.proxy.type");
    if (0 == proxyType)
      return false;

    // Ask tor for its SOCKS listener address and port and compare to the
    // browser preferences.
    const kCmdArg = "net/listeners/socks";
    let resp;
    try {
      let ctrl = controller(m_tb_control_ipc_file, m_tb_control_host, m_tb_control_port, m_tb_control_pass,
        function(err) {
          // An error has occurred.
          torbutton_log(1, err);
        }
      );
      resp = await ctrl.sendCommand("GETINFO " + kCmdArg + "\r\n");
      ctrl.close();
    } catch (e) {
      torbutton_log(1, "torCheckService controller error" + e);
    }

    if (!resp)
      return false;

    function logUnexpectedResponse() {
      if (!didLogError) {
        didLogError = true;
        torbutton_log(5, "Local Tor check: unexpected GETINFO response: " + resp);
      }
    }

    function removeBrackets(aStr) {
      // Remove enclosing square brackets if present.
      if (aStr.startsWith("[") && aStr.endsWith("]"))
        return aStr.substr(1, aStr.length - 2);
      return aStr;
    }

    // Sample response: net/listeners/socks="127.0.0.1:9149" "127.0.0.1:9150"
    // First, check for and remove the command argument prefix.
    if (0 != resp.indexOf(kCmdArg + "=")) {
      logUnexpectedResponse();
      return false;
    }
    resp = resp.substr(kCmdArg.length + 1);

    // Retrieve configured proxy settings and check each listener against them.
    // When the SOCKS prefs are set to use IPC (e.g., a Unix domain socket), a
    // file URL should be present in network.proxy.socks.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1211567
    let socksAddr = Services.prefs.getCharPref("network.proxy.socks");
    let socksPort = Services.prefs.getIntPref("network.proxy.socks_port");
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
    resp.replace(/((\S*?"(.*?)")+\S*|\S+)/g, (a, captured) => {
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
        let idx = addr.lastIndexOf(":");
        if (idx < 0) {
          logUnexpectedResponse();
        } else {
          let torSocksAddr = removeBrackets(addr.substring(0, idx));
          let torSocksPort = parseInt(addr.substring(idx + 1), 10);
          if ((torSocksAddr.length < 1) || isNaN(torSocksPort)) {
            logUnexpectedResponse();
          } else {
            torbutton_log(2, "Tor socks listener: " + torSocksAddr + ":"
                             + torSocksPort);
            foundSocksListener = ((socksAddr === torSocksAddr) &&
                                  (socksPort === torSocksPort));
          }
        }
      }
    }

    return foundSocksListener;
  },
  torbutton_tor_check_ok() {
    return (this.kCheckFailed != this.statusOfTorCheck);
  },
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([TBTorCheckService]);
