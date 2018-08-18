const round = (value, precision) => {
  return Math.round(value * 10 ** precision) / 10 ** precision;
};

module.exports = { round };
