// Captured from Info-ZIP 6.00; unrelated verbose fields were omitted.
export const SAFE_INFO_ZIP_6_FIXTURE = `Archive:  fixture.zip
There is no zipfile comment.

End-of-central-directory record:
-------------------------------

  This zipfile constitutes the sole disk of a single-part archive; its
  central directory contains 3 entries.

Central directory entry #1:
---------------------------

  regular.txt

  file system or operating system of origin:      Unix
  uncompressed size:                              1 bytes
  length of filename:                             11 characters
  Unix file attributes (100664 octal):            -rw-rw-r--
  MS-DOS file attributes (00 hex):                none

Central directory entry #2:
---------------------------

  space ž.txt

  file system or operating system of origin:      Unix
  uncompressed size:                              7 bytes
  length of filename:                             12 characters
  Unix file attributes (100664 octal):            -rw-rw-r--
  MS-DOS file attributes (00 hex):                none

Central directory entry #3:
---------------------------

  dir/

  file system or operating system of origin:      Unix
  uncompressed size:                              0 bytes
  length of filename:                             4 characters
  Unix file attributes (040775 octal):            drwxrwxr-x
  MS-DOS file attributes (10 hex):                dir
`

export const BACKSLASH_INFO_ZIP_6_FIXTURE = `Archive:  backslash.zip
There is no zipfile comment.

  This zipfile constitutes the sole disk of a single-part archive; its
  central directory contains 1 entry.

Central directory entry #1:
---------------------------

  trailing\\

  file system or operating system of origin:      Unix
  uncompressed size:                              5 bytes
  length of filename:                             9 characters
  Unix file attributes (100664 octal):            -rw-rw-r--
  MS-DOS file attributes (00 hex):                none
`

export const SYMLINK_INFO_ZIP_6_FIXTURE = `Archive:  symlink.zip
There is no zipfile comment.

  This zipfile constitutes the sole disk of a single-part archive; its
  central directory contains 1 entry.

Central directory entry #1:
---------------------------

  dir/link

  file system or operating system of origin:      Unix
  uncompressed size:                              14 bytes
  length of filename:                             8 characters
  Unix file attributes (120777 octal):            lrwxrwxrwx
  MS-DOS file attributes (00 hex):                none
`

export const DOS_INFO_ZIP_6_FIXTURE = `Archive:  windows.zip
There is no zipfile comment.

  This zipfile constitutes the sole disk of a single-part archive; its
  central directory contains 2 entries.

Central directory entry #1:
---------------------------

  win-file.txt

  file system or operating system of origin:      MS-DOS, OS/2 or NT FAT
  uncompressed size:                              1 bytes
  length of filename:                             12 characters
  non-MSDOS external file attributes:             000000 hex
  MS-DOS file attributes (20 hex):                arc

Central directory entry #2:
---------------------------

  win-dir/

  file system or operating system of origin:      MS-DOS, OS/2 or NT FAT
  uncompressed size:                              0 bytes
  length of filename:                             8 characters
  non-MSDOS external file attributes:             000000 hex
  MS-DOS file attributes (10 hex):                dir
`

export const EMPTY_INFO_ZIP_6_FIXTURE = `Archive:  empty.zip
There is no zipfile comment.

End-of-central-directory record:
-------------------------------

  This zipfile constitutes the sole disk of a single-part archive; its
  central directory contains 0 entries.
  The central directory is 0 (0000000000000000h) bytes long,
  and its (expected) offset in bytes from the beginning of the zipfile
  is 0 (0000000000000000h).

  Empty zipfile.
`

export const TRUNCATED_INFO_ZIP_6_FIXTURE = `Archive:  truncated.zip
There is no zipfile comment.

  This zipfile constitutes the sole disk of a single-part archive; its
  central directory contains 1 entry.

Central directory entry #1:
---------------------------

  truncated.txt

  file system or operating system of origin:      Unix
  uncompressed size:                              1 bytes
`
