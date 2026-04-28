export interface DirectoryEntry {
	name: string
	path: string
	type: 'file' | 'directory' | 'symlink' | 'other'
	size?: number
}
