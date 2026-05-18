"""Interactive setup wizard package.

Entry point is the repo-root ``setup.py``; the modules here are split so the
pure logic (account model, .env merge, fork rewrites, secret generation) is
unit-tested while the network/subprocess pieces stay thin wrappers.
"""
