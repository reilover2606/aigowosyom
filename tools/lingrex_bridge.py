"""Runs LingRex's correspondence pattern recognition (CoPaR; List 2019) on the word pairs the site
sends it, and prints the patterns as JSON.

Input (stdin, JSON):
    { "ancestor": "name", "descendant": "name",
      "pairs": [ { "id": 1, "concept": "kata", "columns": [ {"a": "k", "b": "g", "tag": "i"}, ... ] } ] }
Each pair is one cognate set: its columns are the site's own alignment (a, b: the sounds, "" for a
gap; tag: i initial / m medial / c final consonant, v vowel). LingRex is given those alignments and
prosodic structure instead of making its own, so it works on the same lining-up the site shows.

Output (stdout): a line starting @@LINGREX@@ followed by JSON (LingPy writes its own chatter to stdout):
    { "patterns": [ { "id", "structure", "ancestor", "descendant", "support", "cognates", "irregular_of" } ],
      "version": "..." }
"""

import json
import logging
import sys

MARK = "@@LINGREX@@"  # LingPy chats on stdout, so the result follows this marker
logging.disable(logging.CRITICAL)


def emit(data):
    sys.stdout.write("\n" + MARK + json.dumps(data, ensure_ascii=False) + "\n")


def main():
    request = json.load(sys.stdin)

    from lingpy import Wordlist
    from lingrex.copar import CoPaR
    import lingrex

    pairs = request["pairs"]
    header = ["doculect", "concept", "form", "tokens", "cogid", "alignment", "structure"]
    rows = {0: header}
    index = 0
    for pair in pairs:
        for side, name in (("a", "A"), ("b", "B")):
            alignment = []
            structure = []
            tokens = []
            for column in pair["columns"]:
                sound = column[side]
                alignment.append(sound if sound else "-")
                if sound:
                    tokens.append(sound)
                    structure.append(column["tag"])
            if not tokens:
                continue
            index += 1
            rows[index] = [
                name, pair["concept"], "".join(tokens), " ".join(tokens), pair["id"],
                " ".join(alignment), " ".join(structure),
            ]

    wordlist = Wordlist(rows)
    cop = CoPaR(
        wordlist, ref="cogid", transcription="form", segments="tokens",
        alignment="alignment", structure="structure", minrefs=2, fuzzy=False,
    )
    cop.get_sites()
    cop.cluster_sites()
    cop.sites_to_pattern()
    cop.irregular_patterns(accepted=2)

    # Which cluster each irregular one was attached to.
    attached = {}
    for regular, irregulars in cop.ipatterns.items():
        for irregular in irregulars:
            attached[irregular] = regular

    taxa = list(cop.cols)  # A first, then B
    patterns = []
    for number, ((structure, pattern), sites) in enumerate(
        sorted(cop.clusters.items(), key=lambda item: (-len(item[1]), item[0])), start=1
    ):
        by_taxon = dict(zip(taxa, pattern))
        regular = attached.get((structure, pattern))
        patterns.append({
            "id": number,
            "structure": structure,
            "ancestor": by_taxon.get("A", ""),
            "descendant": by_taxon.get("B", ""),
            "support": len(sites),
            "cognates": sorted({str(cogid) for cogid, _ in sites})[:8],
            "irregular_of": (
                {"ancestor": dict(zip(taxa, regular[1])).get("A", ""), "descendant": dict(zip(taxa, regular[1])).get("B", "")}
                if regular else None
            ),
        })

    emit({"patterns": patterns, "version": getattr(lingrex, "__version__", "")})


if __name__ == "__main__":
    try:
        main()
    except ImportError as error:
        emit({"error": f"LingRex isn't installed for this Python ({error}). Install it with: pip install lingrex"})
    except Exception as error:  # report, don't crash the page
        emit({"error": f"{type(error).__name__}: {error}"})
