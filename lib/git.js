const nodegit = require("nodegit");
const models = require('./gitModels');
const config = require('../config');

const repository = config.repo;

const getRepo = function() {
    return nodegit.Repository.open(repository)
};

function getListOfFilesInHeadCommit(){
    return new Promise((resolve, reject)=>{
        const repo = getRepo();
        const headCommit = repo.then(repo=>repo.getHeadCommit());
        const tree = headCommit.then(commit=>commit.getTree());
        tree.then(function(tree){
            const walker = tree.walk();
            const files = [];
            walker.on("entry", function(entry) {
                files.push(entry.path());
            });
            walker.start();
            resolve(files);
        });
    });
}

function getCommit(commitId){
    return new Promise((resolve, reject)=>{
        const repo = getRepo();
        const commitPromise = repo.then(repo=>repo.getCommit(commitId));
        commitPromise.then(function(commit){
            resolve(models.commitFactory(commit));
        });
    });
}
function getTreeRest(treeId){
    return new Promise((resolve, reject)=>{
        const repo = getRepo();
        const treePromise = repo.then(repo=>repo.getTree(treeId));
        treePromise.then(function(tree){
            resolve(models.treeFactory(tree));
        });
    });
}
function getBlobRest(blobId){
    return new Promise((resolve, reject)=>{
        const repo = getRepo();
        const blobPromise = repo.then(repo=>repo.getBlob(blobId));
        blobPromise.then(function(blob){
            resolve(models.blobFactory(blob));
        });
    });
}

function getReferences(){
    return new Promise((resolve, reject)=>{
        const repo = getRepo();
        const blobPromise = repo.then(repo=>repo.getReferences());
        const headPromise = repo.then(repo=>repo.head());
        Promise.all([blobPromise, headPromise]).then(function([refs, head]){
            resolve(refs.map(x=>models.referenceFactory(x)).concat(models.referenceFactory(head, true)));
        });
    });
}

function getDiffStatusString(gitoscopeStatus, rawStatus){
    if (gitoscopeStatus.isInWorkingCopy && !gitoscopeStatus.isInCache){
        return 'untracked';
    }
    if (!gitoscopeStatus.isInWorkingCopy && gitoscopeStatus.isInCache){
        return 'deleted';
    }
    if (rawStatus.inWorkingTree && ! rawStatus.isDeleted && !rawStatus.isNew){
        return 'modified';
    }
    return '';
}

function getDiffCachedStatusString(gitoscopeStatus, rawStatus){
    if (gitoscopeStatus.isInCache && !gitoscopeStatus.isInTree){
        return 'new';
    }
    if (!gitoscopeStatus.isInCache && gitoscopeStatus.isInTree){
        return 'deleted';
    }
    if (rawStatus.inIndex && rawStatus.isModified){
        return 'modified';
    }
    return '';
}

function buildStatus(status){
    const rawStatus = Object.keys(status).reduce((acc, prop) => {
        const statusProperty = status[prop];
        if (typeof statusProperty === 'function') {
            acc[prop] = status[prop]();
        } else {
            acc[prop] = statusProperty;
        }
        if (acc[prop] === undefined) {
            acc[prop] = null;
        }
        return acc;
    }, {});

    const gitoscopeStatus = {
        isInWorkingCopy: !rawStatus.isDeleted,
        isInCache: !((rawStatus.inIndex && rawStatus.isDeleted) || (rawStatus.isNew && !rawStatus.inIndex)),
    };


    return Object.assign({}, gitoscopeStatus, {rawStatus});

}

function buildDefaultStatus(){
    return {
        isInWorkingCopy: true,
        isInCache: true,
        isInTree: true,
        diffString: '',
        diffCachedString: ''
    }
}

function statusToJson(statuses, listOfFilesInHeadCommit){
  const res = {};
  statuses.forEach(function(file) {
      const fileStatus = buildStatus(file);
      res[file.path()] = fileStatus;
      fileStatus.isInTree = listOfFilesInHeadCommit.includes(file.path());
      fileStatus['diffString'] = getDiffStatusString(fileStatus, fileStatus.rawStatus);
      fileStatus['diffCachedString'] = getDiffCachedStatusString(fileStatus, fileStatus.rawStatus);

  });

  listOfFilesInHeadCommit.forEach(function(file){
      if (!(file in res)){
          res[file] = buildDefaultStatus(file)
      }
  });


  return res;
}

function getStatus(){
    return new Promise((resolve, reject)=>{
        const repo = getRepo();
        const status = repo.then((repo) => repo.getStatus());
        const listOfFilesInHeadCommit = getListOfFilesInHeadCommit();
        Promise.all([status, listOfFilesInHeadCommit]).then(([statuses, listOfFilesInHeadCommits]) => {
            resolve(statusToJson(statuses, listOfFilesInHeadCommits))
        })
    });
}

function getFile(entry){
    return new Promise((resolve, reject)=>{
        const repo = getRepo();
        const headCommit = repo.then(repo=>repo.getHeadCommit());
        const entryObj = headCommit.then(commit=>commit.getEntry(entry));
        const blob = entryObj.then(entry=>entry.getBlob());
        blob.then(function(blob){
            resolve(blob.toString());
        }).catch((err)=> {
            console.log(err);
            resolve('')
        });
    });
}
function applyDiffLines(oldLinesv, oldStart, oldLines, lines){
    oldLinesv.splice(oldStart -1, oldLines, ...lines);
    return oldLinesv;
}

function retrieveDiffLinesFromRepo(diffMode, repo, commit, resource) {
    return new Promise((resolve, reject)=>{
        const treeObject = commit.getTree();
        const diffObject = treeObject.then(function (tree) {
            return nodegit.Diff[diffMode].call(null, repo, tree);
        });
        const patchesObject = diffObject.then(function (diff) {
            return diff.patches();
        });
        patchesObject.then(function (p) {
            const patchForGivenResource = p.find(patch => patch.oldFile().path() === resource);
            if (!patchForGivenResource){
                resolve([]);
            }
            const hunks = patchForGivenResource.hunks();
            hunks.then(resolvedHunks => {
                const linesByHunk = resolvedHunks.map(resolvedHunk => resolvedHunk.lines());

                Promise.all(linesByHunk).then((retrievedLines) => {
                    resolve(resolvedHunks.map((resolvedHunk, index) => {

                        return {
                            oldStart: resolvedHunk.oldStart(),
                            oldLines: resolvedHunk.oldLines(),
                            lines: retrievedLines[index].filter(x => x.newLineno() !== -1).map((x) => x.rawContent())
                        }
                    }));
                });
            });
        });
    });
};

function buildContentFromDiff(diffFunction, resource, cb){
    return new Promise((resolve, reject)=>{
        let rr;
        const repo = getRepo();
        const headCommit = repo.then((repo)=>{
            rr = repo;
            return repo.getHeadCommit();
        });
        headCommit.then(function(commit) {
            diffFunction(rr, commit, resource).then(diffData=> {
                getFile(resource).then((treeContent)=>{

                    const cache = treeContent.replace(/\n$/g,'').split(/\r?\n/).map(x => x + '\n');
                    if (diffData.length > 0) {
                        const cacheDiffLines = applyDiffLines(cache, diffData[0].oldStart, diffData[0].oldLines, diffData[0].lines);
                        resolve(cacheDiffLines.join(''));
                    } else {
                        resolve(treeContent);
                    }
                })
        }, ()=>resolve(''));
        })
    });
}

const diffWithIndex = retrieveDiffLinesFromRepo.bind(null, 'treeToIndex');
const diffWithWorkdir = retrieveDiffLinesFromRepo.bind(null, 'treeToWorkdir');
const getWorkingCopyContent = buildContentFromDiff.bind(null, diffWithWorkdir);
const getCacheContent = buildContentFromDiff.bind(null, diffWithIndex);

module.exports = {getStatus, getTreeContent: getFile, getWorkingCopyContent, getCacheContent, getCommit, getTreeRest, getBlobRest, getReferences};
