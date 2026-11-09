/**
 * Latter UP — email alerts (Google Apps Script)
 *
 * SETUP (about 5 minutes, signed in as the account the emails should come FROM,
 * e.g. studentleadership@latterup.org):
 *  1. Go to script.new and paste this whole file over the sample code. Save.
 *  2. Left menu -> Project Settings (gear) -> Script Properties -> Add property:
 *       name SECRET, value = any long random phrase you make up (you'll paste the same one into the admin page).
 *  3. Pick the function "authorize" in the toolbar and click Run once. Approve the permission prompt.
 *  4. Deploy -> New deployment -> type "Web app" -> Execute as: Me -> Who has access: Anyone -> Deploy.
 *  5. Copy the Web app URL (ends in /exec).
 *  6. In the portal: Admin -> Email alerts -> paste the URL and the SECRET, tick "Send email alerts", Save,
 *     then click "Send a test email".
 * Emails are only ever sent to @latterup.org addresses.
 */
const ALLOWED_DOMAIN = "@latterup.org";

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
    if (!secret || d.secret !== secret) return reply({ ok: false, error: "bad secret" });
    const to = (d.to || []).map(String).filter(x => x.toLowerCase().endsWith(ALLOWED_DOMAIN));
    if (!to.length) return reply({ ok: false, error: "no valid recipients" });
    const bcc = to.filter(address => address.toLowerCase() !== "studentleadership@latterup.org");
    MailApp.sendEmail({ to: "studentleadership@latterup.org", bcc: bcc.join(","), subject: String(d.subject || "Latter UP").slice(0, 200), body: String(d.text || ""), name: "Latter UP Portal" });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function authorize() { MailApp.getRemainingDailyQuota(); }   // run once so Google asks for email permission
