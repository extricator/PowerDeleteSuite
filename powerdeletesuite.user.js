// ==UserScript==
// @name         Power Delete Suite (maintained fork)
// @namespace    https://github.com/extricator/PowerDeleteSuite
// @version      2.0.0
// @description  Add a PowerDeleteSuite bookmarklet link to your old Reddit overview.
// @author       ObiDriftKenobi; maintained by extricator
// @match        https://old.reddit.com/user/*/overview*
// @match        https://old.reddit.com/u/*/overview*
// @grant        none
// ==/UserScript==
(function () {
  "use strict";
  fetch("https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/bookmarklet.min.js?" + Date.now())
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.text();
    }).then(function (code) {
      if (!code.startsWith("javascript:")) throw new Error("Invalid bookmarklet download");
      var menu = document.querySelector("#header-bottom-right > ul.flat-list");
      if (!menu || document.getElementById("pd-delete")) return;
      var link = document.createElement("a");
      link.id = "pd-delete";
      link.textContent = "PDS";
      link.href = code.trim();
      menu.parentNode.insertBefore(link, menu.nextSibling);
    }).catch(function (error) { alert("PowerDeleteSuite loader: " + error.message); });
})();
