javascript:(function () {
  window.bookmarkver = "2.0";
  var isReddit = document.location.hostname.split(".").slice(-2).join(".") === "reddit.com";
  var isOverview = /^\/(?:user|u)\/[^/]+\/overview\/?$/i.test(document.location.pathname);
  if (isReddit && isOverview) {
    if (window.pd_active) {
      alert("PowerDeleteSuite is already loaded. Use its Stop / Resume controls, or reload the page for a new run.");
      return;
    }
    var url = "https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/powerdeletesuite.js?" + Date.now();
    fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .then(function (code) {
        if (!code.trim()) throw new Error("Empty script download");
        if (window.pd_active) return;
        var script = document.createElement("script");
        script.id = "pd-script";
        script.textContent = code;
        document.head.appendChild(script);
      })
      .catch(function (error) {
        alert("Error retrieving PowerDeleteSuite from GitHub: " + error.message + ". Check your connection and the repository URL, then try again.");
      });
  } else if (confirm("Open your own old.reddit.com overview to run PowerDeleteSuite?")) {
    document.location = "https://old.reddit.com/user/me/overview";
  } else {
    alert("Please open your own Reddit profile overview before running PowerDeleteSuite.");
  }
})();
