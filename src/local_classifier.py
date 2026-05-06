"""
Classifieur local sans appel API.
Détecte newsletter/transactionnel/spam par règles sur expéditeur + sujet.
Économise ~50-70 % des appels GPT sur une boîte typique.
"""
import re
from typing import Dict, Optional

# ── Patterns expéditeur ───────────────────────────────────────────────────────

_NEWSLETTER_SENDER = re.compile(
    r"(noreply|no[_\-]reply|newsletter|mailing|donotreply|do[_\-]not[_\-]reply|"
    r"news@|updates?@|digest@|campaign|mailer|announce|promo|marketing|"
    r"offers?@|deals?@|@mailchimp\.|@sendgrid\.|@klaviyo\.|@constantcontact\.|"
    r"@mailerlite\.|@brevo\.|@sendinblue\.|@hubspotemail\.|"
    r"@em\..*\.com|@bounce\.|via\.mailchimp)",
    re.IGNORECASE,
)

_TRANSACTIONAL_SENDER = re.compile(
    r"(receipt@|invoice@|billing@|order@|orders?@|payment@|confirm@|"
    r"notification@|alert@|security@|verify|verification@|account@|"
    r"support@|helpdesk@|ticket@|no.?reply.*@)",
    re.IGNORECASE,
)

_SPAM_SENDER = re.compile(
    r"(@.*\.xyz$|@.*\.top$|@.*\.click$|@.*\.loan$|winner|prize|"
    r"lottery|lucky|claim.*reward|free.*gift)",
    re.IGNORECASE,
)

# ── Patterns sujet ────────────────────────────────────────────────────────────

_NEWSLETTER_SUBJECT = re.compile(
    r"(unsubscribe|view.?in.?(browser|your browser)|"
    r"newsletter|\bnews\b|digest|weekly|monthly|edition|issue\s+#?\d|"
    r"your .{0,25} (summary|recap|update|roundup)|"
    r"tip(s)? of the (day|week)|bulletin|dispatch)",
    re.IGNORECASE,
)

_TRANSACTIONAL_SUBJECT = re.compile(
    r"(order (confirm|receiv|ship|deliver|dispatch)|"
    r"your (receipt|invoice|payment|subscription|booking|ticket|reservation)|"
    r"(payment|invoice|facture) (received|confirm|due)|"
    r"tracking (number|info|update)|\breceipt\b|\binvoice\b|"
    r"(verify|confirm) (your |the )?(email|account|address)|"
    r"security (alert|code|notification)|"
    r"two.?factor|code de v.{1,10}rification)",
    re.IGNORECASE,
)

_SPAM_SUBJECT = re.compile(
    r"(you('ve| have) (won|been selected|been chosen)|"
    r"(claim|collect) (your )?(prize|reward|gift|winnings)|"
    r"(million|billion).*\$|crypto.*profit|make money fast|"
    r"urgent.*transfer|nigerian|inheritance.*fund)",
    re.IGNORECASE,
)


def _make_result(category: str, score: int, reason: str) -> Dict:
    return {
        "category": category,
        "importance_score": score,
        "importance_reason": reason,
        "summary": "",
        "needs_reply": False,
        "draft_response": None,
        "tokens_in": 0,
        "tokens_out": 0,
        "local_classified": True,
    }


def classify(email_data: Dict) -> Optional[Dict]:
    """
    Tente une classification sans IA.
    Retourne None si incertain → l'appelant doit utiliser GPT.
    """
    sender  = str(email_data.get("sender",  "") or "")
    subject = str(email_data.get("subject", "") or "")

    # Spam en premier (haute priorité)
    if _SPAM_SENDER.search(sender) or _SPAM_SUBJECT.search(subject):
        return _make_result("spam", 1, "Détecté comme spam par règle locale")

    # Newsletter
    if _NEWSLETTER_SENDER.search(sender) or _NEWSLETTER_SUBJECT.search(subject):
        return _make_result("newsletter", 2, "Détecté comme newsletter par règle locale")

    # Transactionnel
    if _TRANSACTIONAL_SENDER.search(sender) or _TRANSACTIONAL_SUBJECT.search(subject):
        return _make_result("transactional", 3, "Détecté comme transactionnel par règle locale")

    return None  # Incertain → GPT nécessaire


def extract_domain(sender: str) -> Optional[str]:
    """Extrait le domaine de l'adresse expéditeur."""
    m = re.search(r"@([\w.\-]+)", sender or "")
    return m.group(1).lower() if m else None
