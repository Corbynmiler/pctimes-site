// STUB — Phase 1 does NOT send email.
//
// This endpoint intentionally does nothing except return a disabled-state
// response. It exists so the architecture is in place; the real SMTP
// implementation lands only after Leanne approves the email integration
// phase and credentials are placed into Netlify environment variables.
//
// Nothing in Phase 1 calls this. It is here so the admin UI can detect the
// email-connection state and so the function slot is reserved.

/** @type {import("@netlify/functions").Handler} */
exports.handler = async () => {
  return {
    statusCode: 503,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: "disabled",
      reason: "email_connection_not_enabled",
      message:
        "Email sending is not connected yet. Phase 1 of the Roster system is review-and-copy only.",
    }),
  };
};
