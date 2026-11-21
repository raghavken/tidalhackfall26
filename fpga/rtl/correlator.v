`timescale 1ns/1ps
// Shared four-station correlation datapath. The pipeline accepts a sample
// every clock. Independent station state is updated on the input edge.
module correlator #(
    parameter [54:0] ENERGY_THRESHOLD = 55'd2250000
)(input wire clk, input wire reset_n, input wire enable,
  input wire [1:0] station_id, input wire [15:0] sample_index,
  input wire signed [15:0] sample_mhz, input wire sample_valid,
  output reg result_valid, output reg [1:0] result_station,
  output reg [15:0] result_index, output reg [54:0] result_energy,
  output reg result_alarm, output reg [3:0] alarms,
  output reg [3:0] published_valid);
    reg signed [41:0] accum_i [0:3];
    reg signed [41:0] accum_q [0:3];
    reg [9:0] count [0:3];
    reg [6:0] phase [0:3];
    reg [54:0] latest_energy [0:3];
    reg [15:0] latest_end [0:3];
    wire signed [15:0] cos_coeff, sin_coeff;
    coefficient_rom rom(phase[station_id],cos_coeff,sin_coeff);
    wire signed [31:0] product_i = sample_mhz * cos_coeff;
    wire signed [31:0] product_q = sample_mhz * sin_coeff;
    wire signed [41:0] next_i = accum_i[station_id] + {{10{product_i[31]}},product_i};
    wire signed [41:0] next_q = accum_q[station_id] + {{10{product_q[31]}},product_q};
    // 42 - 15 = 27: slicing implements the arithmetic shift and exact width.
    wire signed [26:0] scaled_i = next_i[41:15];
    wire signed [26:0] scaled_q = next_q[41:15];
    reg signed [26:0] pipe_i, pipe_q;
    reg pipe_valid;
    reg [1:0] pipe_station;
    reg [15:0] pipe_index;
    wire signed [53:0] square_i = pipe_i * pipe_i;
    wire signed [53:0] square_q = pipe_q * pipe_q;
    wire [54:0] energy = {1'b0,square_i} + {1'b0,square_q};
    integer k;
    always @(posedge clk or negedge reset_n) begin
        if(!reset_n) begin
            result_valid<=0; result_station<=0; result_index<=0; result_energy<=0;
            result_alarm<=0; alarms<=0; published_valid<=0;
            pipe_valid<=0; pipe_i<=0; pipe_q<=0; pipe_station<=0; pipe_index<=0;
            for(k=0;k<4;k=k+1) begin
                accum_i[k]<=0; accum_q[k]<=0; count[k]<=0; phase[k]<=0;
                latest_energy[k]<=0; latest_end[k]<=0;
            end
        end else if(!enable) begin
            result_valid<=0; pipe_valid<=0; alarms<=0; published_valid<=0;
        end else begin
            result_valid<=pipe_valid;
            pipe_valid<=0;
            if(pipe_valid) begin
                result_station<=pipe_station; result_index<=pipe_index;
                result_energy<=energy; result_alarm<=energy>=ENERGY_THRESHOLD;
                alarms[pipe_station]<=energy>=ENERGY_THRESHOLD;
                published_valid[pipe_station]<=1;
                latest_energy[pipe_station]<=energy; latest_end[pipe_station]<=pipe_index;
            end
            if(sample_valid) begin
                if(phase[station_id]==119) phase[station_id]<=0;
                else phase[station_id]<=phase[station_id]+1'b1;
                if(count[station_id]==599) begin
                    // next_i/next_q include the current (600th) measurement.
                    pipe_i<=scaled_i; pipe_q<=scaled_q; pipe_valid<=1;
                    pipe_station<=station_id; pipe_index<=sample_index;
                    count[station_id]<=0; accum_i[station_id]<=0; accum_q[station_id]<=0;
                end else begin
                    count[station_id]<=count[station_id]+1'b1;
                    accum_i[station_id]<=next_i; accum_q[station_id]<=next_q;
                end
            end
        end
    end
endmodule
