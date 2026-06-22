#!/usr/bin/env bash
set -euo pipefail

MIGRATIONS_DIR="${1:-backend/migrations}"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
	echo "Migration directory not found: $MIGRATIONS_DIR" >&2
	exit 1
fi

find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print | sort | awk '
	BEGIN {
		count = 0
		invalid_count = 0
		duplicate_count = 0
		max = 0
	}

	{
		name = $0
		sub(/^.*\//, "", name)

		# Mirror the runtime loader (backend/src/services/migrations.ts):
		# MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9_]+$/  applied to the basename.
		# Exactly four digits, then lowercase alphanumerics/underscores.
		if (name !~ /^[0-9][0-9][0-9][0-9]_[a-z0-9_]+\.sql$/) {
			invalid[++invalid_count] = name
			next
		}

		raw = name
		sub(/_.*/, "", raw)
		number = raw + 0
		count++

		if (number in seen) {
			duplicate[++duplicate_count] = raw ": " seen[number] " and " name
		} else {
			seen[number] = name
		}

		if (number > max) {
			max = number
		}
	}

	END {
		if (count == 0) {
			print "No migration files found." > "/dev/stderr"
			exit 1
		}

		if (invalid_count > 0) {
			print "Invalid migration filenames. Expected NNNN_description.sql:" > "/dev/stderr"
			for (i = 1; i <= invalid_count; i++) {
				print "  " invalid[i] > "/dev/stderr"
			}
			exit 1
		}

		if (duplicate_count > 0) {
			print "Duplicate migration numbers found:" > "/dev/stderr"
			for (i = 1; i <= duplicate_count; i++) {
				print "  " duplicate[i] > "/dev/stderr"
			}
			exit 1
		}

		# Gaps are intentionally tolerated: the merge train renumbered
		# migrations, leaving legitimate non-consecutive numbers (e.g. 0019,
		# 0022, 0042, 0043 missing). The loader sorts by filename, so gaps are
		# harmless. We only enforce uniqueness of migration numbers here.
		printf "Migration numbers OK: %d unique files, max %04d (gaps tolerated)\n", count, max
	}
'
