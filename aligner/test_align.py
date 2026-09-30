"""Unit tests for the alignment maths (no model needed): python -m unittest discover aligner"""

import unittest

import numpy as np

from align import cache_key, grow_spans, itermax, mutual_argmax


class AlignMathTest(unittest.TestCase):
    def test_mutual_argmax_keeps_only_mutual_best_matches(self):
        sim = np.array([[0.9, 0.1], [0.8, 0.2]])
        # row 1's best is col 0, but col 0's best is row 0
        self.assertEqual(mutual_argmax(sim).tolist(), [[True, False], [False, False]])

    def test_itermax_links_leftover_words(self):
        sim = np.array(
            [
                [0.9, 0.1, 0.1],
                [0.75, 0.2, 0.7],  # prefers col 0 (taken) first; col 2 after down-weighting
                [0.1, 0.6, 0.2],
            ]
        )
        links = itermax(sim)
        self.assertTrue(links[0, 0] and links[2, 1])
        self.assertFalse(mutual_argmax(sim)[1].any())
        self.assertTrue(links[1, 2])  # found on the second pass

    def test_grow_spans_extends_over_units_preferring_the_same_word(self):
        # source word 0 ("pallet") is best for target units 0..3 (パ レ ッ ト); only unit 0 is linked
        sim = np.array(
            [
                [0.9, 0.8, 0.7, 0.8, 0.1],
                [0.1, 0.2, 0.2, 0.1, 0.9],
            ]
        )
        links = np.zeros_like(sim, dtype=bool)
        links[0, 0] = links[1, 4] = True
        self.assertEqual(grow_spans(sim, links, max_grow=8), [[0, 3], [4, 4]])
        self.assertEqual(grow_spans(sim, links, max_grow=2), [[0, 2], [4, 4]])

    def test_grow_spans_reports_unaligned_words(self):
        sim = np.array([[0.9, 0.1], [0.2, 0.3]])
        links = np.zeros_like(sim, dtype=bool)
        links[0, 0] = True
        self.assertEqual(grow_spans(sim, links, max_grow=2), [[0, 0], None])

    def test_cache_key_depends_on_model_and_language(self):
        a = cache_key("m1", 8, "itermax", "de", "Issue", "Ausgabe")
        self.assertNotEqual(a, cache_key("m2", 8, "itermax", "de", "Issue", "Ausgabe"))
        self.assertNotEqual(a, cache_key("m1", 8, "itermax", "fr", "Issue", "Ausgabe"))
        self.assertEqual(a, cache_key("m1", 8, "itermax", "de", "Issue", "Ausgabe"))


if __name__ == "__main__":
    unittest.main()
