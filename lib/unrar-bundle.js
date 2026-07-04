// Browser bundle for node-unrar-js (MIT License)
// Combines: unrar.singleton, DataFile, Extractor, ExtractorData, createExtractorFromData

(function(global) {

  // ── DataFile ──
  class DataFile {
    constructor(data) {
      this.buffers = [];
      this.pos = 0;
      this.size = 0;
      if (data) {
        this.buffers.push(data);
        this.size = data.byteLength;
        this.pos = 0;
      }
    }
    read(size) {
      this.flatten();
      if (size + this.pos > this.size) return null;
      const oldPos = this.pos;
      this.pos += size;
      return this.buffers[0].slice(oldPos, this.pos);
    }
    readAll() {
      this.flatten();
      return this.buffers[0] || new Uint8Array();
    }
    write(data) {
      this.buffers.push(data);
      this.size += data.byteLength;
      this.pos += data.byteLength;
      return true;
    }
    tell() { return this.pos; }
    seek(pos, method) {
      let newPos = this.pos;
      if (method === 'SET') newPos = pos;
      else if (method === 'CUR') newPos += pos;
      else newPos = this.size - pos;
      if (newPos < 0 || newPos > this.size) return false;
      this.pos = newPos;
      return true;
    }
    flatten() {
      if (this.buffers.length <= 1) return;
      const newBuffer = new Uint8Array(this.size);
      let offset = 0;
      for (const buffer of this.buffers) {
        newBuffer.set(buffer, offset);
        offset += buffer.byteLength;
      }
      this.buffers = [newBuffer];
    }
  }

  // ── Error codes ──
  const ERROR_CODE = {
    0:'ERAR_SUCCESS',10:'ERAR_END_ARCHIVE',11:'ERAR_NO_MEMORY',12:'ERAR_BAD_DATA',
    13:'ERAR_BAD_ARCHIVE',14:'ERAR_UNKNOWN_FORMAT',15:'ERAR_EOPEN',16:'ERAR_ECREATE',
    17:'ERAR_ECLOSE',18:'ERAR_EREAD',19:'ERAR_EWRITE',20:'ERAR_SMALL_BUF',
    21:'ERAR_UNKNOWN',22:'ERAR_MISSING_PASSWORD',23:'ERAR_EREFERENCE',24:'ERAR_BAD_PASSWORD'
  };
  const ERROR_MSG = {
    ERAR_NO_MEMORY:'Not enough memory',ERAR_BAD_DATA:'Archive header or data are damaged',
    ERAR_BAD_ARCHIVE:'File is not RAR archive',ERAR_UNKNOWN_FORMAT:'Unknown archive format',
    ERAR_EOPEN:'File open error',ERAR_ECREATE:'File create error',ERAR_ECLOSE:'File close error',
    ERAR_EREAD:'File read error',ERAR_EWRITE:'File write error',
    ERAR_SMALL_BUF:'Buffer too small',ERAR_UNKNOWN:'Unknown error',
    ERAR_MISSING_PASSWORD:'Password required',ERAR_EREFERENCE:'Cannot open reference',
    ERAR_BAD_PASSWORD:'Wrong password'
  };

  class UnrarError extends Error {
    constructor(reason, message, file) {
      super(message);
      this.reason = reason;
      this.file = file;
    }
  }

  // ── Extractor (base) ──
  class Extractor {
    constructor(unrar, password = '') {
      this.unrar = unrar;
      this._password = password;
      this._archive = null;
    }
    getFileList() {
      const arcHeader = this.openArc(true);
      const self = this;
      function* getFileHeaders() {
        while (true) {
          const arcFile = self.processNextFile(() => true);
          if (arcFile === 'ERAR_END_ARCHIVE') break;
          yield arcFile.fileHeader;
        }
        self.closeArc();
      }
      return { arcHeader, fileHeaders: getFileHeaders() };
    }
    extract(options = {}) {
      const { files, password } = options;
      const arcHeader = this.openArc(false, password);
      const self = this;
      function* getFiles() {
        let count = 0;
        while (true) {
          let shouldSkip = () => false;
          if (Array.isArray(files)) {
            if (count === files.length) break;
            shouldSkip = ({ name }) => !files.includes(name);
          } else if (files) {
            shouldSkip = (fh) => !files(fh);
          }
          const arcFile = self.processNextFile(shouldSkip);
          if (arcFile === 'ERAR_END_ARCHIVE') break;
          if (arcFile.extraction === 'skipped') continue;
          count++;
          yield { fileHeader: arcFile.fileHeader };
        }
        self.closeArc();
      }
      return { arcHeader, files: getFiles() };
    }
    close(fd) { this.closeFile(fd); }
    openArc(listOnly, password) {
      this._archive = new this.unrar.RarArchive();
      const header = this._archive.open(this._filePath, password || this._password, listOnly);
      if (header.state.errCode !== 0) {
        throw this.getFailException(header.state.errCode, header.state.errType);
      }
      return {
        comment: header.comment,
        flags: {
          volume: (header.flags & 0x0001) !== 0,
          lock: (header.flags & 0x0004) !== 0,
          solid: (header.flags & 0x0008) !== 0,
          authInfo: (header.flags & 0x0020) !== 0,
          recoveryRecord: (header.flags & 0x0040) !== 0,
          headerEncrypted: (header.flags & 0x0080) !== 0,
        },
      };
    }
    processNextFile(shouldSkip) {
      const arcFileHeader = this._archive.getFileHeader();
      if (arcFileHeader.state.errCode === 10) return 'ERAR_END_ARCHIVE';
      if (arcFileHeader.state.errCode !== 0) {
        throw this.getFailException(arcFileHeader.state.errCode, arcFileHeader.state.errType);
      }
      const fileHeader = {
        name: arcFileHeader.name,
        flags: {
          encrypted: (arcFileHeader.flags & 0x04) !== 0,
          solid: (arcFileHeader.flags & 0x10) !== 0,
          directory: (arcFileHeader.flags & 0x20) !== 0,
        },
        packSize: arcFileHeader.packSize,
        unpSize: arcFileHeader.unpSize,
        crc: arcFileHeader.crc,
      };
      const skip = shouldSkip(fileHeader);
      const fileState = this._archive.readFile(skip);
      if (fileState.errCode !== 0) {
        throw this.getFailException(fileState.errCode, fileState.errType, fileHeader.name);
      }
      return { fileHeader, extraction: skip ? 'skipped' : 'extracted' };
    }
    closeArc() {
      this._archive.delete();
      this._archive = null;
    }
    getFailException(errCode, _errType, file) {
      const reason = ERROR_CODE[errCode];
      this.closeArc();
      return new UnrarError(reason, ERROR_MSG[reason], file);
    }
  }

  // ── ExtractorData ──
  class ExtractorData extends Extractor {
    constructor(unrar, data, password) {
      super(unrar, password);
      this.dataFiles = {};
      this.dataFileMap = {};
      this.currentFd = 1;
      const rarFile = {
        file: new DataFile(new Uint8Array(data)),
        fd: this.currentFd++,
      };
      this._filePath = '_defaultUnrarJS_.rar';
      this.dataFiles[this._filePath] = rarFile;
      this.dataFileMap[rarFile.fd] = this._filePath;
    }
    extract(options = {}) {
      const { arcHeader, files } = super.extract(options);
      const self = this;
      function* getFiles() {
        for (const file of files) {
          if (!file.fileHeader.flags.directory) {
            file.extraction = self.dataFiles[self.getExtractedFileName(file.fileHeader.name)].file.readAll();
          }
          yield file;
        }
      }
      return { arcHeader, files: getFiles() };
    }
    getExtractedFileName(filename) { return `*Extracted*/${filename}`; }
    open(filename) {
      const dataFile = this.dataFiles[filename];
      return dataFile ? dataFile.fd : 0;
    }
    create(filename) {
      const fd = this.currentFd++;
      this.dataFiles[this.getExtractedFileName(filename)] = {
        file: new DataFile(),
        fd: this.currentFd++,
      };
      this.dataFileMap[fd] = this.getExtractedFileName(filename);
      return fd;
    }
    closeFile(fd) {
      const fileData = this.dataFiles[this.dataFileMap[fd]];
      if (fileData) fileData.file.seek(0, 'SET');
    }
    read(fd, buf, size) {
      const fileData = this.dataFiles[this.dataFileMap[fd]];
      if (!fileData) return -1;
      const data = fileData.file.read(size);
      if (data === null) return -1;
      this.unrar.HEAPU8.set(data, buf);
      return data.byteLength;
    }
    write(fd, buf, size) {
      const fileData = this.dataFiles[this.dataFileMap[fd]];
      if (!fileData) return false;
      fileData.file.write(this.unrar.HEAPU8.slice(buf, buf + size));
      return true;
    }
    tell(fd) {
      const fileData = this.dataFiles[this.dataFileMap[fd]];
      return fileData ? fileData.file.tell() : -1;
    }
    seek(fd, pos, method) {
      const fileData = this.dataFiles[this.dataFileMap[fd]];
      return fileData ? fileData.file.seek(pos, method) : false;
    }
  }

  // ── WASM loader ──
  let unrarModule = null;

  async function getUnrar(options) {
    if (!unrarModule) {
      // Module is the global factory from unrar.js (loaded via <script> before this file)
      if (typeof Module === 'undefined') {
        throw new Error('unrar.js must be loaded before unrar-bundle.js');
      }
      unrarModule = await Module(options);
    }
    return unrarModule;
  }

  // ── Public API ──
  global.createExtractorFromData = async function({ wasmBinary, data, password = '' }) {
    const opts = {};
    if (wasmBinary) opts.wasmBinary = wasmBinary;
    const unrar = await getUnrar(opts);
    const extractor = new ExtractorData(unrar, data, password);
    unrar.extractor = extractor;
    return extractor;
  };

})(window);
