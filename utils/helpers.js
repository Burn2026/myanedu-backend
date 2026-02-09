const cleanImagePath = (pathStr) => {
    if (!pathStr) return null;
    if (pathStr.includes('uploads')) {
        const filename = pathStr.split(/[/\\]/).pop(); 
        return `uploads/${filename}`;
    }
    return pathStr;
};

module.exports = { cleanImagePath };