#!/usr/bin/env bash
# hygiene-check.sh — keep strategy docs and secrets out of this PUBLIC repo.
#
#   scripts/hygiene-check.sh --all      every file in the tree at HEAD  (CI runs this)
#   scripts/hygiene-check.sh --staged   files staged for commit         (pre-commit hook; default)
#
# Three checks; any hit exits 1 and prints exactly which file/line tripped it:
#   1. forbidden filenames (below)                        — any path, case-insensitive
#   2. terms from .hygiene-terms                          — *.md / *.txt only
#   3. secret patterns from .hygiene-secrets              — every text file
# The two list files are the definitions, so they aren't scanned themselves.
# The local hook is bypassable (git commit --no-verify); CI is the real gate.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mode="${1:---staged}"
case "$mode" in --all|--staged) ;; *) echo "usage: $0 [--all|--staged]" >&2; exit 2 ;; esac

exec perl - "$mode" <<'PERL'
use strict; use warnings;
my $mode = shift;

# 1. Forbidden filenames — matched against each path's basename, case-insensitive.
my @forbidden_names = ("brief", "strategy", "business", "pitch",
                       "sponsor", "moneti", "pricing", "^\\.env");
my %self = map { $_ => 1 } (".hygiene-terms", ".hygiene-secrets");

sub load {
  my ($file, $named) = @_;
  open my $fh, "<", $file or die "hygiene-check: cannot read $file\n";
  my @out;
  while (my $l = <$fh>) {
    chomp $l; $l =~ s/\r$//;
    next if $l =~ /^\s*(#|$)/;
    if ($named) {
      my ($name, $re) = $l =~ /^\s*(\S+)\s+::\s+(.+?)\s*$/ or die "hygiene-check: bad line in $file: $l\n";
      push @out, [$name, qr/$re/];
    } else {
      $l =~ s/\s{2,}#.*$//; $l =~ s/^\s+|\s+$//g;
      push @out, [$l, qr/$l/i];
    }
  }
  return @out;
}
my @terms   = load(".hygiene-terms", 0);
my @secrets = load(".hygiene-secrets", 1);

my @files = $mode eq "--all"
  ? split /\0/, `git ls-tree -r -z --name-only HEAD`
  : split /\0/, `git diff --cached --name-only -z --diff-filter=ACMR`;
my $rev = $mode eq "--all" ? "HEAD" : "";   # "" = the index (staged content)

my @hits;
for my $path (@files) {
  my ($base) = $path =~ m{([^/]+)$};
  for my $re (@forbidden_names) {
    push @hits, "$path: [filename] basename matches /$re/i" if $base =~ /$re/i;
  }
  next if $self{$path};
  open my $git, "-|", "git", "show", "$rev:$path" or die "hygiene-check: git show failed for $path\n";
  binmode $git;
  local $/; my $content = <$git>; close $git;
  next if !defined $content || substr($content, 0, 8000) =~ /\0/;   # binary (images etc.)
  my $is_doc = $path =~ /\.(md|txt)$/i;
  my $n = 0;
  for my $line (split /\n/, $content) {
    $n++;
    for my $s (@secrets) {
      push @hits, "$path:$n: [secret:$s->[0]] (value not printed)" if $line =~ $s->[1];
    }
    next unless $is_doc;
    for my $t (@terms) {
      push @hits, "$path:$n: [term] \"$&\" matches /$t->[0]/i" if $line =~ $t->[1];
    }
  }
}

my $scope = $mode eq "--all" ? "tree at HEAD" : "staged files";
if (@hits) {
  print STDERR "hygiene-check FAILED ($scope) — this repo is PUBLIC:\n";
  print STDERR "  $_\n" for @hits;
  print STDERR "Move strategy to _drafts/ or _private/ (gitignored); never commit secrets.\n";
  print "::error::hygiene-check found " . scalar(@hits) . " problem(s) — see log\n" if $ENV{GITHUB_ACTIONS};
  exit 1;
}
print "hygiene-check passed ($scope): " . scalar(@files) . " files, " . scalar(@terms) . " terms, " . scalar(@secrets) . " secret patterns, " . scalar(@forbidden_names) . " filename patterns\n";
PERL
