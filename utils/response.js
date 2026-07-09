// 统一响应工具
// 兼容记账路由引用的 success/error/page 和旧路由引用的 success/fail/paginated

const success = (res, data, message = 'success') => {
  res.json({ code: 0, message, data });
};

const error = (res, message = 'error', statusCode = 500) => {
  res.status(statusCode).json({ code: -1, message, data: null });
};

const page = (res, list, total, pageNum, pageSize, meta = null) => {
  const body = {
    code: 0,
    message: 'success',
    data: {
      list,
      total,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    }
  };
  if (meta) body.data._meta = meta;
  res.json(body);
};

module.exports = {
  // 新命名（记账路由）
  success,
  error,
  page,

  // 旧命名（其他路由兼容）
  fail: (res, statusCode, message) => res.status(statusCode).json({ code: statusCode, message, data: null }),
  // 各路由直接 res.json(paginated(...)) 调用，paginated 返回纯数据对象
  paginated: (list, total, pageNum, pageSize) => ({
    code: 0,
    data: { list, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) }
  })
};
