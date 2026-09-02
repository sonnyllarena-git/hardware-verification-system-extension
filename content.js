// Runs on the check page (/check?apiKey=...&name=...&email=...) and hands those
// URL params to the extension popup on request, since the popup itself has no
// access to the check page's window.location.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "sendParams") {
    const params = new URLSearchParams(window.location.search);
    sendResponse({
      params: {
        apiKey: params.get("apiKey"),
        applicantName: params.get("name"),
        applicantEmail: params.get("email"),
      },
    });
  }
});
