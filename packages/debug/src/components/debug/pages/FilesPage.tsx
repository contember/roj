import { useCallback, useEffect, useState } from 'react'
import { api, getApiBaseUrl } from '@roj-ai/client'
import { useDebugSessionId } from '../DebugNavigation.js'

type Root = 'session' | 'workspace'

interface DirectoryEntry {
	name: string
	type: 'file' | 'directory'
	size: number
	mimeType?: string
}

interface DirectoryListing {
	entries: DirectoryEntry[]
	path: string
	root: string
}

function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B'
	const units = ['B', 'KB', 'MB', 'GB']
	const i = Math.floor(Math.log(bytes) / Math.log(1024))
	const size = bytes / Math.pow(1024, i)
	return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function isImageMime(mimeType: string | undefined): boolean {
	return mimeType?.startsWith('image/') ?? false
}

function isTextMime(mimeType: string | undefined): boolean {
	if (!mimeType) return false
	return mimeType.startsWith('text/')
		|| mimeType === 'application/json'
		|| mimeType === 'application/javascript'
}

export function FilesPage() {
	const sessionId = useDebugSessionId()
	const [root, setRoot] = useState<Root>('session')
	const [currentPath, setCurrentPath] = useState('')
	const [listing, setListing] = useState<DirectoryListing | null>(null)
	const [listingError, setListingError] = useState<string | null>(null)
	const [listingLoading, setListingLoading] = useState(false)
	const [selectedFile, setSelectedFile] = useState<{ path: string; entry: DirectoryEntry } | null>(null)
	const [fileContent, setFileContent] = useState<string | null>(null)
	const [fileUrl, setFileUrl] = useState<string | null>(null)
	const [fileLoading, setFileLoading] = useState(false)
	const [fileError, setFileError] = useState<string | null>(null)

	const fetchListing = useCallback(async (r: Root, path: string) => {
		if (!sessionId) return
		setListingLoading(true)
		setListingError(null)

		try {
			const method = r === 'session' ? 'filesystem.listSession' : 'filesystem.listWorkspace'
			const result = await api.call(method, { sessionId, path: path || undefined })
			if (!result.ok) {
				setListingError(result.error.message)
				setListing(null)
				return
			}
			setListing(result.value)
		} catch (e) {
			setListingError(e instanceof Error ? e.message : 'Failed to fetch listing')
			setListing(null)
		} finally {
			setListingLoading(false)
		}
	}, [sessionId])

	// Fetch listing when root or path changes
	useEffect(() => {
		fetchListing(root, currentPath)
	}, [root, currentPath, fetchListing])

	// Fetch file content when a file is selected
	useEffect(() => {
		if (!selectedFile || !sessionId) {
			setFileContent(null)
			setFileUrl(null)
			setFileError(null)
			return
		}

		const baseUrl = getApiBaseUrl()
		const routePrefix = root === 'session' ? 'files' : 'workspace'
		const url = `${baseUrl}/sessions/${sessionId}/${routePrefix}/${selectedFile.path}`

		if (isImageMime(selectedFile.entry.mimeType)) {
			setFileUrl(url)
			setFileContent(null)
			setFileLoading(false)
			setFileError(null)
			return
		}

		if (isTextMime(selectedFile.entry.mimeType)) {
			setFileLoading(true)
			setFileError(null)
			setFileUrl(null)
			fetch(url)
				.then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`)
					return res.text()
				})
				.then((text) => {
					setFileContent(text)
					setFileLoading(false)
				})
				.catch((e) => {
					setFileError(e instanceof Error ? e.message : 'Failed to fetch file')
					setFileLoading(false)
				})
			return
		}

		// Non-text, non-image: just show info + download link
		setFileUrl(url)
		setFileContent(null)
		setFileLoading(false)
		setFileError(null)
	}, [selectedFile, sessionId, root])

	const handleNavigate = (entry: DirectoryEntry) => {
		if (entry.type === 'directory') {
			const newPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
			setCurrentPath(newPath)
			setSelectedFile(null)
		} else {
			const filePath = currentPath ? `${currentPath}/${entry.name}` : entry.name
			setSelectedFile({ path: filePath, entry })
		}
	}

	const handleRootChange = (newRoot: Root) => {
		setRoot(newRoot)
		setCurrentPath('')
		setSelectedFile(null)
	}

	const handleBreadcrumbClick = (index: number) => {
		if (index === -1) {
			setCurrentPath('')
		} else {
			const parts = currentPath.split('/')
			setCurrentPath(parts.slice(0, index + 1).join('/'))
		}
		setSelectedFile(null)
	}

	if (!sessionId) return null

	const pathParts = currentPath ? currentPath.split('/') : []

	return (
		<div className="h-full flex gap-4">
			{/* Left panel - Directory browser */}
			<div className="w-80 shrink-0 bg-white rounded-md border border-slate-200 flex flex-col">
				{/* Root tabs */}
				<div className="flex border-b border-slate-200">
					<button
						onClick={() => handleRootChange('session')}
						className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
							root === 'session'
								? 'text-violet-700 border-b-2 border-violet-600 bg-violet-50'
								: 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
						}`}
					>
						Session
					</button>
					<button
						onClick={() => handleRootChange('workspace')}
						className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
							root === 'workspace'
								? 'text-violet-700 border-b-2 border-violet-600 bg-violet-50'
								: 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
						}`}
					>
						Workspace
					</button>
				</div>

				{/* Breadcrumbs */}
				<div className="px-3 py-2 border-b border-slate-100 flex items-center gap-1 text-sm overflow-x-auto">
					<button
						onClick={() => handleBreadcrumbClick(-1)}
						className="text-violet-600 hover:underline shrink-0"
					>
						/
					</button>
					{pathParts.map((part, i) => (
						<span key={i} className="flex items-center gap-1 shrink-0">
							<span className="text-slate-400">/</span>
							{i < pathParts.length - 1
								? (
									<button
										onClick={() => handleBreadcrumbClick(i)}
										className="text-violet-600 hover:underline"
									>
										{part}
									</button>
								)
								: <span className="text-slate-700 font-medium">{part}</span>}
						</span>
					))}
				</div>

				{/* Directory listing */}
				<div className="flex-1 overflow-auto">
					{listingLoading
						? <div className="p-3 text-slate-500 text-sm">Loading...</div>
						: listingError
						? <div className="p-3 text-red-500 text-sm">{listingError}</div>
						: !listing || listing.entries.length === 0
						? <div className="p-3 text-slate-500 text-sm">Empty directory</div>
						: (
							<div className="divide-y divide-slate-100">
								{currentPath && (
									<button
										onClick={() => {
											const parts = currentPath.split('/')
											parts.pop()
											setCurrentPath(parts.join('/'))
											setSelectedFile(null)
										}}
										className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-500 hover:bg-slate-50 text-left"
									>
										<FolderUpIcon />
										<span>..</span>
									</button>
								)}
								{listing.entries.map((entry) => {
									const isSelected = selectedFile
										&& entry.type === 'file'
										&& selectedFile.entry.name === entry.name
										&& selectedFile.path === (currentPath ? `${currentPath}/${entry.name}` : entry.name)

									return (
										<button
											key={entry.name}
											onClick={() => handleNavigate(entry)}
											className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
												isSelected
													? 'bg-violet-50 text-violet-700'
													: 'text-slate-700 hover:bg-slate-50'
											}`}
										>
											{entry.type === 'directory' ? <FolderIcon /> : <FileIcon />}
											<span className="truncate flex-1">{entry.name}</span>
											{entry.type === 'file' && (
												<span className="text-xs text-slate-400 shrink-0">
													{formatFileSize(entry.size)}
												</span>
											)}
										</button>
									)
								})}
							</div>
						)}
				</div>
			</div>

			{/* Right panel - File viewer */}
			<div className="flex-1 bg-white rounded-md border border-slate-200 flex flex-col min-w-0">
				<div className="p-3 border-b border-slate-200">
					<h2 className="font-medium text-slate-900">
						{selectedFile ? selectedFile.path : 'File Viewer'}
					</h2>
					{selectedFile && (
						<div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
							<span>{selectedFile.entry.mimeType ?? 'unknown type'}</span>
							<span>{formatFileSize(selectedFile.entry.size)}</span>
						</div>
					)}
				</div>
				<div className="flex-1 overflow-auto p-4">
					{!selectedFile
						? (
							<div className="text-slate-500 text-sm">
								Select a file from the directory browser to view its contents
							</div>
						)
						: fileLoading
						? <div className="text-slate-500 text-sm">Loading file...</div>
						: fileError
						? <div className="text-red-500 text-sm">{fileError}</div>
						: fileContent !== null
						? (
							<pre className="text-xs font-mono whitespace-pre-wrap break-words bg-slate-50 p-4 rounded-md border border-slate-200 overflow-auto max-h-full">
								{fileContent}
							</pre>
						)
						: fileUrl && isImageMime(selectedFile.entry.mimeType)
						? (
							<div className="flex items-center justify-center">
								<img
									src={fileUrl}
									alt={selectedFile.entry.name}
									className="max-w-full max-h-[70vh] object-contain rounded border border-slate-200"
								/>
							</div>
						)
						: fileUrl
						? (
							<div className="space-y-3">
								<p className="text-sm text-slate-600">
									This file type cannot be previewed.
								</p>
								<a
									href={fileUrl}
									download={selectedFile.entry.name}
									className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-violet-700 bg-violet-50 rounded-md hover:bg-violet-100 transition-colors"
								>
									<DownloadIcon />
									Download {selectedFile.entry.name}
								</a>
							</div>
						)
						: null}
				</div>
			</div>
		</div>
	)
}

// Icons

function FolderIcon() {
	return (
		<svg className="w-4 h-4 text-yellow-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
			<path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
		</svg>
	)
}

function FolderUpIcon() {
	return (
		<svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 10l6-6m-6 6l6 6" />
		</svg>
	)
}

function FileIcon() {
	return (
		<svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
			/>
		</svg>
	)
}

function DownloadIcon() {
	return (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
		</svg>
	)
}
