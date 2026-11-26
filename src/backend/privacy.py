"""The three privacy modes a session can be created with. One place, so the database, the API
and the browser all use the same three words.

    standard   the server can read questions, so Gemini can group them and suggest answers.
    encrypted  end to end. The server only stores ciphertext. The host's browser hands the key
               to each participant while the host is online. Grouping runs in the browser.
    passcode   same encryption, but the key comes from a 6 character code the host shares.
               Nobody's browser has to be online to hand it out. The code is never stored.

`encrypted` (a yes/no) is still handy inside the server, so it is derived from the mode here
instead of being stored a second time.
"""

STANDARD = 'standard'
ENCRYPTED = 'encrypted'
PASSCODE = 'passcode'

PRIVACY_MODES = (STANDARD, ENCRYPTED, PASSCODE)


def normalize(mode):
    """Return a valid mode. None or empty means the default. Anything else unknown raises."""
    if mode is None or mode == '':
        return STANDARD
    if mode not in PRIVACY_MODES:
        raise ValueError(f"privacyMode must be one of: {', '.join(PRIVACY_MODES)}")
    return mode


def is_encrypted(mode):
    return mode != STANDARD


def from_row(row):
    """Mode for a database row.

    Rows written before the privacy_mode column existed only have the old encrypted and
    hashed_identity flags. The column also defaults to 'standard', so a room created by an old
    server during the cutover reads 'standard' there while its old flags say otherwise. Anything
    stronger than standard wins, from either source, so a room can never be read as less
    private than it was made."""
    mode = row.get('privacy_mode')
    if mode in (ENCRYPTED, PASSCODE):
        return mode
    if row.get('hashed_identity'):
        return PASSCODE
    if row.get('encrypted'):
        return ENCRYPTED
    return STANDARD
