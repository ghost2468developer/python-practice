"""Small helpers shared across apps."""
import random
import string

from django.utils.text import slugify as django_slugify


def unique_slug(value, model, field="slug", separator="-"):
    base = django_slugify(value)[:50] or "workspace"
    candidate, index = base, 1
    while model.objects.filter(**{field: candidate}).exists():
        index += 1
        candidate = f"{base}{separator}{index}"[:63]
    return candidate


def project_key_from_name(name: str) -> str:
    letters = "".join(char for char in name if char.isalnum() or char.isspace()).strip()
    words = [word for word in letters.split() if word]
    if len(words) >= 2:
        key = "".join(word[0] for word in words)
    else:
        key = letters[:4] or "PRJ"
    return key.upper()[:5]


def make_token(length: int = 32) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(random.SystemRandom().choice(alphabet) for _ in range(length))
